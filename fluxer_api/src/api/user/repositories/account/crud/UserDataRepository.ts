// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {isSyntheticUserId} from '@app/api/constants/Core';
import {executeConditional, fetchMany, fetchOne, fetchPage, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db, type DbOp, nextVersion} from '@app/api/database/CassandraTypes';
import {applyPatchToRow, buildPatchFromData, executeVersionedUpdate} from '@app/api/database/CassandraVersionedUpdate';
import type {TokenRange} from '@app/api/database/TokenRangeScan';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {EMPTY_USER_ROW, USER_COLUMNS} from '@app/api/database/types/UserTypes';
import {emitAccountChangedIfRelevant} from '@app/api/infrastructure/activity/AccountChangeEvents';
import {User} from '@app/api/models/User';
import {Users} from '@app/api/Tables';
import {isPendingDeletionBlocked} from '@app/api/user/services/PendingDeletionCoordinator';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {
	DELETED_USER_DISCRIMINATOR,
	DELETED_USER_ID,
	DELETED_USER_USERNAME,
	UserFlags,
} from '@fluxer/constants/src/UserConstants';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {BACKGROUND_READ_TIMEOUT_MS} from '@pkgs/cassandra/src/Client';
import {UserIndexRepository} from './UserIndexRepository';

const FLUXER_BOT_USER_ID = 0n;
const FETCH_USERS_BY_IDS_CQL = Users.selectCql({
	where: Users.where.in('user_id', 'user_ids'),
});
const FETCH_USER_BY_ID_CQL = Users.selectCql({
	where: Users.where.eq('user_id'),
	limit: 1,
});
const FETCH_ALL_USERS_SCAN_CQL = Users.selectCql();
const SCAN_USERS_TOKEN_RANGE_CQL = Users.selectCql({
	where: Users.where.tokenRange('user_id', 'token_start', 'token_end'),
});
const FETCH_ACTIVITY_TRACKING_CQL = Users.selectCql({
	columns: ['last_active_at', 'last_active_ip'],
	where: Users.where.eq('user_id'),
	limit: 1,
});

function createFetchAllUsersFirstPageQuery(limit: number) {
	return Users.select({limit});
}

const createFetchAllUsersPaginatedQuery = (limit: number) =>
	Users.select({
		where: Users.where.tokenGt('user_id', 'last_user_id'),
		limit,
	});

type UserPatch = Partial<{
	[K in Exclude<keyof UserRow, 'user_id'> & string]: DbOp<UserRow[K]>;
}>;

export type UserDeletionTransition = 'schedule' | 'anonymise' | 'complete';

function assertOrdinaryUserPatch(patch: UserPatch): void {
	if (patch.pending_deletion_at || patch.deletion_started_at) {
		throw new Error('User deletion state must be changed through the deletion lifecycle');
	}
}

function assertWritableUserId(userId: UserID): void {
	if (isSyntheticUserId(userId)) {
		throw new Error(`Refusing to write a users row for synthetic user ${userId}`);
	}
}

function profilePatch(patch: UserPatch, current: UserRow | null): UserPatch {
	if (current?.bot || current?.system) return patch;
	const {
		username: _username,
		discriminator: _discriminator,
		username_state: _state,
		identity_version: _identityVersion,
		...profile
	} = patch;
	return profile;
}

function legacyIdentityPatch(patch: UserPatch, current: UserRow | null, deadlineAt: number): UserPatch {
	if (!current) throw new UnknownUserError();
	const next = applyPatchToRow(current, patch);
	if (
		!current.bot &&
		!current.system &&
		(patch.username_state ||
			patch.identity_version ||
			!Number.isInteger(next.discriminator) ||
			next.discriminator! < 1 ||
			next.discriminator! > 9999)
	)
		throw new Error('Human legacy identity requires a nonzero discriminator');
	if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt || deadlineAt > Date.now() + 30000)
		throw new Error('Legacy identity write deadline expired');
	return patch;
}

export class UserDataRepository {
	async anonymizeLegacyIdentityForDeletion(user: User, deadlineAt: number): Promise<void> {
		if (!user.deletionStartedAt || !user.pendingDeletionAt)
			throw new Error('Deletion must be started before anonymizing identity');
		// Micup: delete the old key before erasing it, so a legacy retry cannot lose its index key.
		await new UserIndexRepository().deleteIndices(user.id, user.username, user.discriminator);
		if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt || deadlineAt > Date.now() + 30000)
			throw new Error('Legacy identity write deadline expired');
		await upsertOne(
			Users.patchByPk(
				{user_id: user.id},
				{
					username: Db.set(DELETED_USER_USERNAME),
					discriminator: Db.set(DELETED_USER_DISCRIMINATOR),
					username_state: Db.clear(),
				},
			),
		);
	}
	async createUserRow(data: UserRow): Promise<{finalVersion: number; previousData: null; updatedData: UserRow}> {
		assertWritableUserId(data.user_id);
		if (
			!data.bot &&
			!data.system &&
			!(data.flags && data.flags & UserFlags.DELETED) &&
			(!Number.isInteger(data.discriminator) ||
				data.discriminator < 1 ||
				data.discriminator > 9999 ||
				data.username_state ||
				data.identity_version)
		) {
			throw new Error('Human accounts must be created with a nonzero legacy identity');
		}
		const updatedData = {...EMPTY_USER_ROW, ...data, version: data.version ?? 1};
		if (!(await executeConditional(Users.insertIfNotExists(updatedData)))) throw new Error('User already exists');
		await emitAccountChangedIfRelevant(null, updatedData);
		return {finalVersion: updatedData.version, previousData: null, updatedData};
	}

	async findUnique(userId: UserID): Promise<User | null> {
		if (userId === FLUXER_BOT_USER_ID) {
			return new User({
				...EMPTY_USER_ROW,
				user_id: createUserID(FLUXER_BOT_USER_ID),
				username: 'sanalyer',
				discriminator: 0,
				bot: true,
				system: true,
				flags: UserFlags.STAFF,
			});
		}
		if (userId === DELETED_USER_ID) {
			return new User({
				...EMPTY_USER_ROW,
				user_id: createUserID(DELETED_USER_ID),
				username: 'DeletedUser',
				discriminator: 0,
				bot: false,
				system: false,
			});
		}
		const userRow = await fetchOne<UserRow>(FETCH_USER_BY_ID_CQL, {user_id: userId});
		return userRow ? new User(userRow) : null;
	}

	async findUniqueAssert(userId: UserID): Promise<User> {
		const user = await this.findUnique(userId);
		if (!user) {
			throw new UnknownUserError();
		}
		return user;
	}

	async listAllUsersPaginated(limit: number, lastUserId?: UserID): Promise<Array<User>> {
		let users: Array<UserRow>;
		if (lastUserId) {
			const query = createFetchAllUsersPaginatedQuery(limit);
			users = await fetchMany<UserRow>(query.bind({last_user_id: lastUserId}));
		} else {
			const query = createFetchAllUsersFirstPageQuery(limit);
			users = await fetchMany<UserRow>(query.bind({}));
		}
		return users.map((row) => new User(row));
	}

	async scanAllUsersPage(
		limit: number,
		pageState?: string | null,
	): Promise<{
		users: Array<User>;
		pageState: string | null;
	}> {
		const result = await fetchPage<UserRow>(
			FETCH_ALL_USERS_SCAN_CQL,
			{},
			{pageSize: limit, pageState, readTimeout: BACKGROUND_READ_TIMEOUT_MS},
		);
		return {
			// Micup: maintenance scans stay readonly; public payloads use verified find/list reads.
			users: result.rows.map((row) => new User(row)),
			pageState: result.pageState,
		};
	}

	async scanUsersTokenRangePage(
		range: TokenRange,
		limit: number,
		pageState?: string | null,
	): Promise<{
		users: Array<User>;
		pageState: string | null;
	}> {
		const result = await fetchPage<UserRow>(
			SCAN_USERS_TOKEN_RANGE_CQL,
			{token_start: range.start, token_end: range.end},
			{pageSize: limit, pageState, readTimeout: BACKGROUND_READ_TIMEOUT_MS},
		);
		return {
			// Micup: token-range validation must not repair ownership or amplify each scanned row.
			users: result.rows.map((row) => new User(row)),
			pageState: result.pageState,
		};
	}

	async listUsers(userIds: Array<UserID>): Promise<Array<User>> {
		if (userIds.length === 0) return [];
		const users = await fetchMany<UserRow>(FETCH_USERS_BY_IDS_CQL, {user_ids: userIds});
		return users.map((row) => new User(row));
	}

	async upsertUserRow(
		data: UserRow,
		oldData?: UserRow | null,
	): Promise<{
		finalVersion: number | null;
		previousData: UserRow | null;
		updatedData: UserRow;
	}> {
		const userId = data.user_id;
		assertWritableUserId(userId);
		let writtenPatch: UserPatch = {};
		const result = await executeVersionedUpdate<UserRow, 'user_id'>(
			async () => {
				return fetchOne<UserRow>(FETCH_USER_BY_ID_CQL, {user_id: userId});
			},
			(current) => {
				writtenPatch = profilePatch(buildPatchFromData(data, current, USER_COLUMNS, ['user_id']), current);
				assertOrdinaryUserPatch(writtenPatch);
				return {pk: {user_id: userId}, patch: writtenPatch};
			},
			Users,
			{initialData: oldData},
		);
		const updatedData = {
			...(applyPatchToRow<UserRow>(result.previousData, writtenPatch) as UserRow),
			user_id: userId,
			version: result.finalVersion ?? data.version,
		};
		await emitAccountChangedIfRelevant(result.previousData, updatedData);
		return {finalVersion: result.finalVersion, previousData: result.previousData, updatedData};
	}

	async patchUser(
		userId: UserID,
		patch: UserPatch,
		oldData?: UserRow | null,
		legacyIdentityDeadlineAt?: number,
	): Promise<{
		finalVersion: number | null;
		previousData: UserRow | null;
		updatedData: UserRow;
	}> {
		assertWritableUserId(userId);
		assertOrdinaryUserPatch(patch);
		let writtenPatch: UserPatch = {};
		const result = await executeVersionedUpdate<UserRow, 'user_id'>(
			async () => {
				return fetchOne<UserRow>(FETCH_USER_BY_ID_CQL, {user_id: userId});
			},
			(current) => {
				writtenPatch =
					legacyIdentityDeadlineAt === undefined
						? profilePatch(patch, current)
						: legacyIdentityPatch(patch, current, legacyIdentityDeadlineAt);
				return {pk: {user_id: userId}, patch: writtenPatch};
			},
			Users,
			{initialData: oldData},
		);
		const previousData = result.previousData;
		const updatedData = {
			...(applyPatchToRow<UserRow>(previousData, writtenPatch) as UserRow),
			user_id: userId,
			version: result.finalVersion ?? nextVersion(previousData?.version),
		};
		await emitAccountChangedIfRelevant(previousData, updatedData);
		return {finalVersion: result.finalVersion, previousData, updatedData};
	}

	async patchDeletion(
		user: User,
		patch: UserPatch,
		transition: UserDeletionTransition,
	): Promise<{
		finalVersion: number;
		previousData: UserRow;
		updatedData: UserRow;
	}> {
		assertWritableUserId(user.id);
		if (patch.deletion_started_at) throw new Error('The deletion start marker is immutable');
		if (transition === 'schedule' && user.deletionStartedAt) {
			throw new ConflictError({code: APIErrorCodes.CONFLICT, message: 'Account deletion has already started'});
		}
		if (transition !== 'schedule' && (!user.deletionStartedAt || !user.pendingDeletionAt)) {
			throw new Error('Account deletion must be started before completion');
		}
		if (transition === 'anonymise' && patch.pending_deletion_at) {
			throw new Error('Account deletion must retain its schedule until cleanup completes');
		}
		const previousData = user.toRow();
		patch = profilePatch(patch, previousData);
		const finalVersion = nextVersion(user.version);
		const applied = await executeConditional(
			Users.conditionalPatchByPk(
				{user_id: user.id},
				{...patch, version: Db.set(finalVersion)},
				{
					pending_deletion_at: user.pendingDeletionAt,
					deletion_started_at: transition === 'schedule' ? null : user.deletionStartedAt,
					flags: previousData.flags,
					version: user.version,
				},
			),
		);
		if (!applied) {
			throw new ConflictError({code: APIErrorCodes.CONFLICT, message: 'Account deletion state has changed'});
		}
		const updatedData = {...previousData, ...applyPatchToRow(previousData, patch), version: finalVersion};
		await emitAccountChangedIfRelevant(previousData, updatedData, 'deletion');
		return {finalVersion, previousData, updatedData};
	}

	async compareAndSetFlags(user: User, flags: bigint): Promise<{previousData: UserRow; updatedData: UserRow} | null> {
		assertWritableUserId(user.id);
		const previousData = user.toRow();
		const version = nextVersion(user.version);
		const expected = previousData.flags ?? 0n;
		const conditions: Array<Partial<UserRow>> = [{flags: expected}];
		if (expected === 0n && previousData.version != null) {
			conditions.push({flags: null, version: previousData.version});
		}
		for (const condition of conditions) {
			const applied = await executeConditional(
				Users.conditionalPatchByPk({user_id: user.id}, {flags: Db.set(flags), version: Db.set(version)}, condition),
			);
			if (!applied) continue;
			const updatedData = {...previousData, flags, version};
			await emitAccountChangedIfRelevant(previousData, updatedData);
			return {previousData, updatedData};
		}
		return null;
	}

	// Micup: `previous` is the row this call wrote over (null when it wrote nothing), for the account write hooks.
	async startDeletion(userId: UserID, pendingDeletionAt: Date): Promise<{user: User; previous: UserRow | null} | null> {
		assertWritableUserId(userId);
		const scheduledAt = pendingDeletionAt.getTime();
		if (!Number.isFinite(scheduledAt)) throw new Error('Account deletion requires a valid captured schedule');
		const user = await this.findUnique(userId);
		if (!user || user.pendingDeletionAt?.getTime() !== scheduledAt) return null;
		if (user.deletionStartedAt) return {user, previous: null};
		const startedAt = new Date();
		if (scheduledAt > startedAt.getTime() || isPendingDeletionBlocked(user)) return null;
		const version = nextVersion(user.version);
		const applied = await executeConditional(
			Users.conditionalPatchByPk(
				{user_id: userId},
				{deletion_started_at: Db.set(startedAt), version: Db.set(version)},
				{pending_deletion_at: pendingDeletionAt, deletion_started_at: null, flags: user.flags, version: user.version},
			),
		);
		if (!applied) {
			throw new ConflictError({code: APIErrorCodes.CONFLICT, message: 'Account deletion state has changed'});
		}
		return {user: new User({...user.toRow(), deletion_started_at: startedAt, version}), previous: user.toRow()};
	}

	async updateLastActiveAt(params: {userId: UserID; lastActiveAt: Date; lastActiveIp?: string}): Promise<{
		previousData: {
			last_active_at: Date | null;
			last_active_ip: string | null;
		};
		updatedData: {
			last_active_at: Date | null;
			last_active_ip: string | null;
		};
	}> {
		const {userId, lastActiveAt, lastActiveIp} = params;
		assertWritableUserId(userId);
		const previousData = (await this.getActivityTracking(userId)) ?? {last_active_at: null, last_active_ip: null};
		await upsertOne(
			Users.patchByPk(
				{user_id: userId},
				{
					last_active_at: Db.set(lastActiveAt),
					last_active_ip: lastActiveIp !== undefined ? Db.set(lastActiveIp) : Db.clear(),
				},
			),
		);
		return {
			previousData,
			updatedData: {last_active_at: lastActiveAt, last_active_ip: lastActiveIp ?? null},
		};
	}

	async getActivityTracking(userId: UserID): Promise<{
		last_active_at: Date | null;
		last_active_ip: string | null;
	} | null> {
		const result = await fetchOne<{
			last_active_at: Date | null;
			last_active_ip: string | null;
		}>(FETCH_ACTIVITY_TRACKING_CQL, {user_id: userId});
		return result;
	}

	async updateSubscriptionStatus(
		userId: UserID,
		updates: {
			premiumWillCancel: boolean;
			computedPremiumUntil: Date | null;
		},
	): Promise<{
		finalVersion: number | null;
		previousData: UserRow | null;
		updatedData: UserRow | null;
	}> {
		assertWritableUserId(userId);
		const result = await executeVersionedUpdate<UserRow, 'user_id'>(
			async () => {
				return fetchOne<UserRow>(FETCH_USER_BY_ID_CQL, {user_id: userId});
			},
			(_current) => {
				const computedPremiumUntil = updates.computedPremiumUntil;
				const patch: UserPatch = {
					premium_will_cancel: Db.set(updates.premiumWillCancel),
					premium_until: computedPremiumUntil ? Db.set(computedPremiumUntil) : Db.clear(),
				};
				return {
					pk: {user_id: userId},
					patch,
				};
			},
			Users,
		);
		// Micup: both rows for the account write hooks (the patch above, applied to the row it read).
		const previousData = result.previousData;
		const updatedData = previousData && {
			...previousData,
			premium_will_cancel: updates.premiumWillCancel,
			premium_until: updates.computedPremiumUntil,
			version: result.finalVersion ?? previousData.version,
		};
		return {finalVersion: result.finalVersion, previousData, updatedData};
	}
}
