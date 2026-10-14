// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {
	UsernameClaimRow,
	UsernameEntitlementRow,
	UsernameOpIntentRow,
	UsernameOwnerRow,
	UserRow,
} from '@app/api/database/types/UserTypes';
import {
	UserByUsername,
	UsernameClaims,
	UsernameEntitlements,
	UsernameHoldsByBucket,
	UsernameOpIntents,
	UsernameOwners,
	Users,
} from '@app/api/Tables';
import type {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {expect} from 'vitest';

export class OwnershipInvariants {
	private readonly committed = new Map<UserID, Map<string, bigint>>();
	private readonly projected = new Map<UserID, bigint>();
	private readonly previousOwners = new Map<UserID, UsernameOwnerRow>();
	constructor(
		private readonly db: InMemoryCassandraQueryExecutor,
		private readonly now: () => number = Date.now,
	) {}
	async instant(): Promise<void> {
		const owners = await this.db.executeQuery<UsernameOwnerRow>(UsernameOwners.select().bind({}));
		const claims = await this.db.executeQuery<UsernameClaimRow>(UsernameClaims.select().bind({}));
		const users = await this.db.executeQuery<UserRow>(Users.select().bind({}));
		for (const owner of owners) {
			const previous = this.previousOwners.get(owner.user_id);
			if (
				previous &&
				owner.owned_gen > previous.owned_gen &&
				owner.op_kind === 'self' &&
				previous.selected_at &&
				previous.status !== 'reselect_required' &&
				previous.free_change_used &&
				previous.changed_at
			)
				expect(owner.op_at!.getTime()).toBeGreaterThanOrEqual(previous.changed_at.getTime() + 14 * 86400000);
			let history = this.committed.get(owner.user_id);
			if (!history) {
				history = new Map();
				this.committed.set(owner.user_id, history);
			}
			if (owner.username) history.set(owner.username, owner.owned_gen);
			if (owner.op_phase === 'committed' && owner.op_kind === 'moderation')
				history.set(`kullanici#${owner.op_neutral_disc}`, owner.owned_gen);
			if (owner.op_phase === 'committed' && owner.op_kind === 'delete') {
				const identity = JSON.parse(owner.op_anon_identity!);
				history.set(`${identity.username}#${identity.discriminator}`, owner.owned_gen);
			}
			for (const claim of claims.filter((claim) => claim.state === 'assigned' && claim.user_id === owner.user_id))
				expect([owner.username, ...(owner.op_phase === 'committed' ? [owner.op_old] : [])]).toContain(claim.username);
			this.previousOwners.set(owner.user_id, {...owner});
		}
		for (const claim of claims.filter((claim) => claim.state === 'pending' && claim.prev_blocked_until))
			expect(claim.prev_blocked_until!.getTime()).toBeLessThanOrEqual(this.now());
		for (const claim of claims.filter((claim) => claim.state === 'assigned')) {
			expect(claim.user_id).not.toBeNull();
			expect(owners.filter((owner) => owner.user_id === claim.user_id)).toHaveLength(1);
			expect(claims.filter((other) => other.username === claim.username && other.state === 'assigned')).toHaveLength(1);
		}
		for (const user of users) {
			if (user.username === 'legacy') continue;
			const key =
				user.discriminator === 0 && user.username_state === 'selected'
					? user.username
					: `${user.username}#${user.discriminator}`;
			const generation = this.committed.get(user.user_id)?.get(key);
			expect(generation, `projection ${key} must have committed`).toBeDefined();
			expect(generation! >= (this.projected.get(user.user_id) ?? 0n)).toBe(true);
			this.projected.set(user.user_id, generation!);
		}
	}
	async converged(): Promise<void> {
		await this.instant();
		const owners = await this.db.executeQuery<UsernameOwnerRow>(UsernameOwners.select().bind({}));
		const claims = await this.db.executeQuery<UsernameClaimRow>(UsernameClaims.select().bind({}));
		const entitlements = await this.db.executeQuery<UsernameEntitlementRow>(UsernameEntitlements.select().bind({}));
		const intents = await this.db.executeQuery<UsernameOpIntentRow>(UsernameOpIntents.select().bind({}));
		// Micup: delayed aborted claims are safe only while orphaned; first-touch scenarios prove restoration.
		for (const claim of claims.filter((claim) => claim.state === 'pending')) {
			const owner = owners.find((row) => row.user_id === claim.user_id);
			expect(owner?.op_id).not.toBe(claim.op_id);
			expect(['none', 'held', 'released']).toContain(claim.prev_state);
		}
		const holds = await this.db.executeQuery<{username: string}>(UsernameHoldsByBucket.select().bind({}));
		for (const claim of claims.filter((claim) => claim.state === 'held'))
			expect(holds.some((index) => index.username === claim.username)).toBe(true);
		expect(intents).toEqual([]);
		for (const owner of owners) {
			expect(owner.op_id).toBeNull();
			if (owner.username) {
				expect(claims.find((claim) => claim.username === owner.username)).toMatchObject({
					state: 'assigned',
					user_id: owner.user_id,
					owned_gen: owner.owned_gen,
				});
				const projection = (
					await this.db.executeQuery<UserRow>(
						Users.select({where: Users.where.eq('user_id')}).bind({user_id: owner.user_id}),
					)
				)[0]!;
				expect(projection).toMatchObject({username: owner.username, discriminator: 0, username_state: 'selected'});
				expect(
					await this.db.executeQuery(
						UserByUsername.select({
							where: [
								UserByUsername.where.eq('username'),
								UserByUsername.where.eq('discriminator'),
								UserByUsername.where.eq('user_id'),
							],
						}).bind({username: owner.username, discriminator: 0, user_id: owner.user_id}),
					),
				).toHaveLength(1);
			} else if (owner.status === 'reselect_required' || owner.status === 'deleted') {
				const projection = (
					await this.db.executeQuery<UserRow>(
						Users.select({where: Users.where.eq('user_id')}).bind({user_id: owner.user_id}),
					)
				)[0]!;
				expect(projection.username_state ?? null).toBe(
					owner.status === 'reselect_required' ? 'reselect_required' : null,
				);
				if (owner.status === 'reselect_required') {
					expect(projection.username).toBe('kullanici');
					expect(projection.discriminator).toBeGreaterThan(0);
				}
				expect(claims.filter((claim) => claim.state === 'assigned' && claim.user_id === owner.user_id)).toEqual([]);
			}
			for (const entitlement of entitlements.filter(
				(row) => row.user_id === owner.user_id && row.revoked_at === null && row.bound_gen !== null,
			))
				expect(entitlement).toMatchObject({username: owner.username, bound_gen: owner.owned_gen});
			const indices = await this.db.executeQuery<{username: string; discriminator: number; user_id: UserID}>(
				UserByUsername.select().bind({}),
			);
			const projection = (
				await this.db.executeQuery<UserRow>(
					Users.select({where: Users.where.eq('user_id')}).bind({user_id: owner.user_id}),
				)
			)[0]!;
			for (const index of indices.filter((row) => row.user_id === owner.user_id)) {
				expect(owner.status).not.toBe('deleted');
				expect(index).toMatchObject({
					username: projection.username.toLowerCase(),
					discriminator: projection.discriminator,
				});
			}
		}
	}
}
