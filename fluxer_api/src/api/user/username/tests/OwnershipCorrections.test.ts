// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {UsernameClaimRow} from '@app/api/database/types/UserTypes';
import {UserByUsername, UsernameHoldsByBucket, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {holdBucket, UsernameOwnershipRepository} from '../UsernameOwnershipRepository';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {UsernameRepairSweeper} from '../UsernameRepairSweeper';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';
import {OwnershipInvariants} from './OwnershipInvariants';

const uid = createUserID(200n);
const ctx = {adminId: createUserID(999n), reason: 'test', note: 'test'};
let now: number;
let backend: 'cassandra' | 'postgres';
let db: InMemoryCassandraQueryExecutor;
let policy: FakeUsernamePolicyService;
let invariant: OwnershipInvariants;
const make = (repository = new UsernameOwnershipRepository()) =>
	new UsernameOwnershipService({
		repository,
		policy,
		now: () => now,
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
function latch() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {promise, release};
}
beforeEach(async () => {
	backend = Config.database.backend;
	Config.database.backend = 'cassandra';
	now = Date.parse('2099-10-09T12:00:00Z');
	db = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(db);
	policy = new FakeUsernamePolicyService();
	invariant = new OwnershipInvariants(db, () => now);
	await executeQuery(
		Users.patchByPk(
			{user_id: uid},
			{username: Db.set('legacy'), discriminator: Db.set(4567)},
			{timestamp: BigInt(now) * 1000n - 100n},
		),
	);
	await executeQuery(
		UserByUsername.upsertAll(
			{username: 'legacy', discriminator: 4567, user_id: uid},
			{timestamp: BigInt(now) * 1000n - 100n},
		),
	);
});
afterEach(() => {
	Config.database.backend = backend;
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});

describe('C14 ownership corrections', () => {
	it('abort increments seq without advancing owned_gen before the next successful commit', async () => {
		const other = createUserID(201n);
		await executeQuery(Users.patchByPk({user_id: other}, {username: Db.set('legacy'), discriminator: Db.set(4568)}));
		const api = make();
		await api.claimSelf(other, 'taken');
		await api.claimSelf(uid, 'first');
		await invariant.instant();
		expect(await api.claimSelf(uid, 'taken')).toMatchObject({ok: false, code: 'TAKEN'});
		expect(await api.repository.readOwner(uid)).toMatchObject({seq: 2n, owned_gen: 1n, op_id: null});
		await invariant.instant();
		expect(await api.claimSelf(uid, 'second')).toMatchObject({ok: true});
		expect(await api.repository.readOwner(uid)).toMatchObject({seq: 3n, owned_gen: 3n});
		await invariant.converged();
	});
	it.each(['before', 'after'] as const)(
		'deleteAccount retries a crash %s anonymous projection with the persisted identity',
		async (timing) => {
			const api = make();
			await api.claimSelf(uid, 'first');
			await invariant.instant();
			class CrashedDeleteRepository extends UsernameOwnershipRepository {
				override async writeProjection(...args: Parameters<UsernameOwnershipRepository['writeProjection']>) {
					if (timing === 'after') await super.writeProjection(...args);
					throw new Error('process stopped during deletion');
				}
			}
			await expect(
				make(new CrashedDeleteRepository()).deleteAccount(uid, {username: 'DeletedUser', discriminator: 0}),
			).rejects.toThrow();
			await invariant.instant();
			expect(await api.repository.readOwner(uid)).toMatchObject({status: 'deleted', op_phase: 'committed'});
			await expect(
				api.deleteAccount(uid, {username: 'different_retry_value', discriminator: 1234}),
			).resolves.toBeUndefined();
			await executeQuery(Users.patchByPk({user_id: uid}, {email: Db.set(null)}));
			await expect(
				api.deleteAccount(uid, {username: 'different_retry_value', discriminator: 1234}),
			).resolves.toBeUndefined();
			expect(await api.repository.readProjection(uid)).toMatchObject({username: 'DeletedUser', discriminator: 0});
			expect(await api.repository.readOwner(uid)).toMatchObject({seq: 2n, owned_gen: 2n, op_id: null});
			await invariant.converged();
		},
	);
	it.each(['bot', 'system'] as const)('%s accounts never acquire an owner', async (flag) => {
		await executeQuery(Users.patchByPk({user_id: uid}, {[flag]: Db.set(true)}));
		const api = make();
		expect(await api.claimSelf(uid, 'first')).toMatchObject({ok: false, code: 'UNAVAILABLE'});
		expect(await api.repository.readOwner(uid)).toBeNull();
		await invariant.converged();
	});
	it.each(['hold', 'listing', 'availability', 'claim'] as const)(
		'delayed orphan INSERT is restored on first %s touch',
		async (touch) => {
			const reached = latch();
			const resume = latch();
			class DelayedClaimRepository extends UsernameOwnershipRepository {
				override async insertClaim(row: UsernameClaimRow): Promise<UsernameClaimRow | null> {
					reached.release();
					await resume.promise;
					await super.insertClaim(row);
					throw new Error('process stopped after delayed claim');
				}
			}
			const pending = make(new DelayedClaimRepository()).claimSelf(uid, 'first');
			await reached.promise;
			now += 61000;
			await make().repair(uid);
			resume.release();
			await pending;
			const api = make();
			expect(await api.repository.readClaim('first')).toMatchObject({state: 'pending'});
			expect(await api.resolveBareName('first')).toBeNull();
			await invariant.instant();
			if (touch === 'hold') expect(await api.adminHold('first', ctx)).toMatchObject({ok: true});
			else if (touch === 'claim') expect(await api.claimSelf(uid, 'first')).toMatchObject({ok: true});
			else if (touch === 'availability') {
				expect(api).toHaveProperty('readClaimForAvailability');
				expect(await api.readClaimForAvailability('first')).toBeNull();
			} else {
				const orphan = (await api.repository.readClaim('first'))!;
				await api.repository.writeHoldIndex({...orphan, updated_at: new Date(now)});
				await new UsernameRepairSweeper({ownership: api, now: () => now}).cleanupHoldBucket(holdBucket('first'));
			}
			expect((await api.repository.readClaim('first'))?.state).not.toBe('pending');
			await invariant.converged();
		},
	);
	it('owner version fences a projection captured before a concurrent finalize', async () => {
		const reached = latch();
		const resume = latch();
		class PausedProjectionRepository extends UsernameOwnershipRepository {
			override async readProjection(userId: typeof uid) {
				const projection = await super.readProjection(userId);
				reached.release();
				await resume.promise;
				return projection;
			}
		}
		const pending = make(new PausedProjectionRepository()).claimSelf(uid, 'second');
		await reached.promise;
		expect(await make().claimSelf(uid, 'first')).toMatchObject({ok: true});
		await invariant.instant();
		resume.release();
		await pending;
		await make().claimSelf(uid, 'second');
		expect(await make().repository.hasIndex(uid, 'first', 0)).toBe(false);
		await invariant.converged();
	});
	it('abort restores a held index above its cleanup tombstone after a crash', async () => {
		const api = make();
		await api.adminHold('first', ctx);
		const held = (await api.repository.readClaim('first'))!;
		now += 301000;
		class CleanupBeforeAbortRepository extends UsernameOwnershipRepository {
			override async insertClaim(row: UsernameClaimRow) {
				return super.insertClaim(row);
			}
			override async casClaim(row: UsernameClaimRow, values: Partial<UsernameClaimRow>) {
				const result = await super.casClaim(row, values);
				if (values.state === 'pending') {
					await new UsernameRepairSweeper({ownership: api, now: () => now}).cleanupHoldBucket(holdBucket('first'));
					policy.snapshot.policyRevision++;
				}
				if (values.state === 'held') throw new Error('crash after held restore CAS');
				return result;
			}
		}
		expect(await make(new CleanupBeforeAbortRepository()).adminAssign('first', uid, ctx)).toMatchObject({ok: false});
		await api.repair(uid);
		expect(await api.repository.readClaim('first')).toMatchObject({state: 'held'});
		expect((await api.repository.readClaim('first'))!.index_ts).toBeGreaterThan(held.index_ts);
		expect(await executeQuery(UsernameHoldsByBucket.select().bind({}))).toHaveLength(1);
		await invariant.converged();
	});
	it('all observed user cell timestamps are passed in one projection advance', async () => {
		const base = BigInt(now) * 1000n;
		await executeQuery(Users.patchByPk({user_id: uid}, {username: Db.set('legacy')}, {timestamp: base + 2000000n}));
		await executeQuery(Users.patchByPk({user_id: uid}, {discriminator: Db.set(4567)}, {timestamp: base + 4000000n}));
		let moves = 0;
		class CountRepository extends UsernameOwnershipRepository {
			override async casOwner(...args: Parameters<UsernameOwnershipRepository['casOwner']>) {
				if (args[1].op_proj_ts && !args[1].op_id) moves++;
				return super.casOwner(...args);
			}
		}
		const api = make(new CountRepository());
		expect(await api.claimSelf(uid, 'first')).toMatchObject({ok: true});
		expect(moves).toBe(1);
		expect((await api.repository.readOwner(uid))!.last_proj_ts).toBeGreaterThan(base + 4000000n);
		await invariant.converged();
	});
	it('second index mismatch warns and keeps the committed intent for a later repair', async () => {
		const api = make();
		const ahead = BigInt(now) * 1000n + 2000000n;
		await executeQuery(
			UserByUsername.deleteByPk({username: 'first', discriminator: 0, user_id: uid}, {timestamp: ahead}),
		);
		expect(await api.claimSelf(uid, 'first')).toMatchObject({ok: false, code: 'UNAVAILABLE'});
		expect(api.projectionMismatchCount).toBe(1);
		expect(await api.repository.readOwner(uid)).toMatchObject({op_phase: 'committed'});
		await invariant.instant();
		now += 2001;
		await api.repair(uid);
		await invariant.converged();
	});
});
