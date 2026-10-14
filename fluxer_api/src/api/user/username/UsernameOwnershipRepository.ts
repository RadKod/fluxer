// SPDX-License-Identifier: AGPL-3.0-or-later
import {crc32} from 'node:zlib';
import type {UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeConditional, executeQuery} from '@app/api/database/CassandraQueryExecution';
import {Db, type DbOp, type PreparedQuery} from '@app/api/database/CassandraTypes';
import type {
	UsernameClaimRow,
	UsernameEntitlementRow,
	UsernameHoldByBucketRow,
	UsernameOpIntentRow,
	UsernameOwnerRow,
	UserRow,
} from '@app/api/database/types/UserTypes';
import {USERNAME_OWNER_COLUMNS} from '@app/api/database/types/UserTypes';
import {
	UserByUsername,
	UsernameClaims,
	UsernameEntitlements,
	UsernameHoldsByBucket,
	UsernameOpIntents,
	UsernameOwners,
	Users,
} from '@app/api/Tables';
import cassandra, {types} from 'cassandra-driver';

function patch<T extends object>(values: Partial<T>): Partial<{[K in keyof T]: DbOp<T[K]>}> {
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Db.set(value)])) as Partial<{
		[K in keyof T]: DbOp<T[K]>;
	}>;
}
export function emptyOwner(user_id: UserID): UsernameOwnerRow {
	return {
		...Object.fromEntries(USERNAME_OWNER_COLUMNS.filter((key) => key.startsWith('op_')).map((key) => [key, null])),
		user_id,
		username: null,
		owned_gen: 0n,
		seq: 0n,
		status: 'active',
		reselect_reason: null,
		selected_at: null,
		changed_at: null,
		free_change_used: false,
		last_proj_ts: 0n,
		version: 0,
	} as UsernameOwnerRow;
}
export function clearOperation(): Partial<UsernameOwnerRow> {
	return Object.fromEntries(USERNAME_OWNER_COLUMNS.filter((key) => key.startsWith('op_')).map((key) => [key, null]));
}
export function intentDay(at: Date): types.LocalDate {
	return types.LocalDate.fromString(at.toISOString().slice(0, 10));
}
// Micup: a snowflake's low bits are its per-millisecond sequence (mostly 0), so the bucket hashes the whole id.
export function intentBucket(userId: UserID): number {
	return crc32(userId.toString()) % 64;
}
export function holdBucket(name: string): number {
	return crc32(name) % 1024;
}

export class UsernameOwnershipRepository {
	assertSupported(): void {
		if (Config.database.backend !== 'cassandra') throw new Error('Username ownership requires Cassandra');
	}
	private async serial<T>(query: PreparedQuery): Promise<T | null> {
		return (await executeQuery<T>(query, undefined, {consistency: 'serial'}))[0] ?? null;
	}
	// Micup: every uncertain CAS is resolved by a serial read of its authority.
	private async mutation<T>(query: PreparedQuery, read: () => Promise<T | null>): Promise<T | null> {
		try {
			await executeConditional(query);
		} catch (cause) {
			if (
				!(cause instanceof cassandra.errors.OperationTimedOutError) &&
				!(
					cause instanceof cassandra.errors.ResponseError &&
					cause.code === cassandra.types.responseErrorCodes.writeTimeout
				)
			)
				throw cause;
		}
		return read();
	}
	readOwner(userId: UserID): Promise<UsernameOwnerRow | null> {
		return this.serial(UsernameOwners.select({where: UsernameOwners.where.eq('user_id')}).bind({user_id: userId}));
	}
	readClaim(name: string): Promise<UsernameClaimRow | null> {
		return this.serial(UsernameClaims.select({where: UsernameClaims.where.eq('username')}).bind({username: name}));
	}
	readEntitlement(userId: UserID): Promise<UsernameEntitlementRow | null> {
		return this.serial(
			UsernameEntitlements.select({where: UsernameEntitlements.where.eq('user_id')}).bind({user_id: userId}),
		);
	}
	async ensureOwner(userId: UserID): Promise<UsernameOwnerRow> {
		const found = await this.readOwner(userId);
		if (found) return found;
		const row = await this.mutation(UsernameOwners.insertIfNotExists(emptyOwner(userId)), () => this.readOwner(userId));
		if (!row) throw new Error('Username owner unavailable');
		return row;
	}
	casOwner(row: UsernameOwnerRow, values: Partial<UsernameOwnerRow>): Promise<UsernameOwnerRow | null> {
		return this.mutation(
			UsernameOwners.conditionalPatchByPk({user_id: row.user_id}, patch({...values, version: row.version + 1}), {
				version: row.version,
				op_id: row.op_id,
				op_phase: row.op_phase,
			}),
			() => this.readOwner(row.user_id),
		);
	}
	insertClaim(row: UsernameClaimRow): Promise<UsernameClaimRow | null> {
		return this.mutation(UsernameClaims.insertIfNotExists(row), () => this.readClaim(row.username));
	}
	casClaim(row: UsernameClaimRow, values: Partial<UsernameClaimRow>): Promise<UsernameClaimRow | null> {
		const {username: _, ...updates} = values;
		return this.mutation(
			UsernameClaims.conditionalPatchByPk({username: row.username}, patch({...updates, version: row.version + 1}), {
				version: row.version,
				state: row.state,
				user_id: row.user_id,
				owned_gen: row.owned_gen,
				op_id: row.op_id,
			}),
			() => this.readClaim(row.username),
		);
	}
	deleteClaim(row: UsernameClaimRow): Promise<UsernameClaimRow | null> {
		return this.mutation(
			UsernameClaims.conditionalDeleteByPk(
				{username: row.username},
				{version: row.version, state: 'pending', op_id: row.op_id},
			),
			() => this.readClaim(row.username),
		);
	}
	writeEntitlement(
		expected: UsernameEntitlementRow | null,
		next: UsernameEntitlementRow,
	): Promise<UsernameEntitlementRow | null> {
		const {user_id, ...values} = next;
		const query = expected
			? UsernameEntitlements.conditionalPatchByPk({user_id}, patch({...values, version: expected.version + 1}), {
					version: expected.version,
					grant_ref: expected.grant_ref,
					bound_gen: expected.bound_gen,
					revoked_at: expected.revoked_at,
				})
			: UsernameEntitlements.insertIfNotExists(next);
		return this.mutation(query, () => this.readEntitlement(next.user_id));
	}
	async writeIntent(userId: UserID, opId: string, at: Date): Promise<void> {
		await executeQuery(
			UsernameOpIntents.upsertAll({
				bucket: intentBucket(userId),
				day: intentDay(at),
				user_id: userId,
				op_id: opId,
				created_at: at,
			}),
		);
	}
	// Micup: a caller holding the stored row passes its bucket, so rows written under an earlier bucket formula stay deletable.
	async deleteIntent(userId: UserID, opId: string, at: Date, bucket = intentBucket(userId)): Promise<void> {
		await executeQuery(UsernameOpIntents.deleteByPk({bucket, day: intentDay(at), user_id: userId, op_id: opId}));
	}
	async listIntents(
		day: string,
		bucket: number,
		after: {user_id: UserID; op_id: string} | null,
		limit: number,
	): Promise<Array<UsernameOpIntentRow>> {
		return executeQuery<UsernameOpIntentRow>(
			UsernameOpIntents.select({
				where: [
					UsernameOpIntents.where.eq('bucket'),
					UsernameOpIntents.where.eq('day'),
					...(after ? [UsernameOpIntents.where.tupleGt(['user_id', 'op_id'], ['after_user_id', 'after_op_id'])] : []),
				],
				limit,
			}).bind({
				bucket,
				day: types.LocalDate.fromString(day),
				...(after ? {after_user_id: after.user_id, after_op_id: after.op_id} : {}),
			}),
		);
	}
	async readProjection(userId: UserID): Promise<
		| (UserRow & {
				username_time: bigint | null;
				discriminator_time: bigint | null;
				state_time: bigint | null;
				identity_time: bigint | null;
		  })
		| null
	> {
		return (
			(
				await executeQuery<
					UserRow & {
						username_time: bigint | null;
						discriminator_time: bigint | null;
						state_time: bigint | null;
						identity_time: bigint | null;
					}
				>(
					Users.select({
						where: Users.where.eq('user_id'),
						writeTime: {
							username: 'username_time',
							discriminator: 'discriminator_time',
							username_state: 'state_time',
							identity_version: 'identity_time',
						},
					}).bind({user_id: userId}),
				)
			)[0] ?? null
		);
	}
	async writeProjection(
		row: UsernameOwnerRow,
		identity: {username: string; discriminator: number; state: 'selected' | 'reselect_required' | null},
	): Promise<void> {
		const timestamp = row.op_proj_ts!;
		const key = {
			username: identity.username.toLowerCase(),
			discriminator: identity.discriminator,
			user_id: row.user_id,
		};
		if (row.op_kind !== 'delete') await executeQuery(UserByUsername.upsertAll(key, {timestamp}));
		await executeQuery(
			Users.patchByPk(
				{user_id: row.user_id},
				{
					username: Db.set(identity.username),
					discriminator: Db.set(identity.discriminator),
					username_state: Db.set(identity.state),
					identity_version: Db.set(row.op_seq!),
				},
				{timestamp},
			),
		);
		if (
			row.op_old_index_username !== null &&
			row.op_old_index_disc !== null &&
			(row.op_kind === 'delete' ||
				row.op_old_index_username.toLowerCase() !== key.username ||
				row.op_old_index_disc !== key.discriminator)
		)
			await executeQuery(
				UserByUsername.deleteByPk(
					{
						username: row.op_old_index_username.toLowerCase(),
						discriminator: row.op_old_index_disc,
						user_id: row.user_id,
					},
					{timestamp},
				),
			);
	}
	async hasIndex(userId: UserID, username: string, discriminator: number): Promise<boolean> {
		return (
			(
				await executeQuery(
					UserByUsername.select({
						where: [
							UserByUsername.where.eq('username'),
							UserByUsername.where.eq('discriminator'),
							UserByUsername.where.eq('user_id'),
						],
					}).bind({username: username.toLowerCase(), discriminator, user_id: userId}),
				)
			).length > 0
		);
	}
	async writeHoldIndex(row: UsernameClaimRow): Promise<void> {
		await executeQuery(
			UsernameHoldsByBucket.upsertAll(
				{bucket: holdBucket(row.username), username: row.username, held_at: row.updated_at},
				{timestamp: row.index_ts},
			),
		);
	}
	async deleteHoldIndex(row: UsernameClaimRow): Promise<void> {
		await executeQuery(
			UsernameHoldsByBucket.deleteByPk(
				{bucket: holdBucket(row.username), username: row.username},
				{timestamp: row.index_ts},
			),
		);
	}
	async listHoldIndex(bucket: number, after: string | null, limit: number): Promise<Array<UsernameHoldByBucketRow>> {
		return executeQuery<UsernameHoldByBucketRow>(
			UsernameHoldsByBucket.select({
				where: [
					UsernameHoldsByBucket.where.eq('bucket'),
					...(after ? [UsernameHoldsByBucket.where.gt('username', 'after_username')] : []),
				],
				limit,
			}).bind({bucket, ...(after ? {after_username: after} : {})}),
		);
	}
	async coordinatorTime(): Promise<Date> {
		const rows = await executeQuery<{coordinator_time: Date}>(
			'SELECT toTimestamp(now()) AS coordinator_time FROM system.local',
			{},
		);
		if (!(rows[0]?.coordinator_time instanceof Date)) throw new Error('Coordinator clock unavailable');
		return rows[0].coordinator_time;
	}
}
