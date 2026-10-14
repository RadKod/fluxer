// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {UsernameOpIntents, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {intentBucket, intentDay, UsernameOwnershipRepository} from '../UsernameOwnershipRepository';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {UsernameRepairSweeper} from '../UsernameRepairSweeper';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';
import {OwnershipInvariants} from './OwnershipInvariants';

const uid = createUserID(200n);
let now: number;
let db: InMemoryCassandraQueryExecutor;
let state: Record<string, unknown> | null;
const config = {
	readUsernameRepairState: async () => state,
	compareAndSetUsernameRepairState: async (expected: unknown, next: Record<string, unknown>) => {
		if (JSON.stringify(state) !== JSON.stringify(expected)) return false;
		state = structuredClone(next);
		return true;
	},
};
let ownership: UsernameOwnershipService;
let originalBackend: 'cassandra' | 'postgres';
beforeEach(async () => {
	originalBackend = Config.database.backend;
	Config.database.backend = 'cassandra';
	now = Date.parse('2099-10-09T12:00:00Z');
	state = null;
	db = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(db);
	ownership = new UsernameOwnershipService({
		policy: new FakeUsernamePolicyService(),
		now: () => now,
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
	await executeQuery(Users.patchByPk({user_id: uid}, {username: Db.set('legacy'), discriminator: Db.set(4567)}));
});
afterEach(() => {
	Config.database.backend = originalBackend;
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});
describe('durable repair sweeper', () => {
	it('five-thousand permanently failing intents do not starve the next record after restart', async () => {
		let fail = true;
		class FailingRepository extends UsernameOwnershipRepository {
			override async deleteIntent(userId: typeof uid, opId: string, at: Date) {
				if (fail && opId !== 'failure_05000') throw new Error('persistent failure');
				await super.deleteIntent(userId, opId, at);
			}
		}
		const failing = new UsernameOwnershipService({
			repository: new FailingRepository(),
			policy: new FakeUsernamePolicyService(),
			now: () => now,
			clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
			admit: async () => true,
			propagate: async () => {},
			neutralDiscriminator: async () => 1234,
		});
		for (let index = 0; index < 5001; index++)
			await failing.repository.writeIntent(uid, `failure_${index.toString().padStart(5, '0')}`, new Date(now - 61000));
		await new UsernameRepairSweeper({ownership: failing, config, now: () => now}).run();
		expect(state!.after_op_id).toBe('failure_04999');
		expect(state!.oldest_day).toBe('2099-10-09');
		await new UsernameRepairSweeper({ownership: failing, config, now: () => now}).run();
		expect(
			(await db.executeQuery<{op_id: string}>(UsernameOpIntents.select().bind({}))).some(
				(row) => row.op_id === 'failure_05000',
			),
		).toBe(false);
		fail = false;
		for (let turn = 0; turn < 3; turn++)
			await new UsernameRepairSweeper({ownership: failing, config, now: () => now}).run();
		await new OwnershipInvariants(db).converged();
	}, 60000);
	it.each(['throw', 'incomplete'] as const)(
		'a failed intent (%s) backs off exponentially while the scan keeps advancing',
		async (failure) => {
			let attempts = 0;
			class FailingRepository extends UsernameOwnershipRepository {
				override async casOwner(...args: Parameters<UsernameOwnershipRepository['casOwner']>) {
					if (failure === 'incomplete') {
						attempts++;
						return args[0];
					}
					return super.casOwner(...args);
				}
				override async deleteIntent() {
					attempts++;
					throw new Error('persistent failure');
				}
			}
			const failing = new UsernameOwnershipService({
				repository: new FailingRepository(),
				policy: new FakeUsernamePolicyService(),
				now: () => now,
				clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
				admit: async () => true,
				propagate: async () => {},
				neutralDiscriminator: async () => 1234,
			});
			await failing.repository.writeIntent(uid, 'failure', new Date(now - 61000));
			const sweeper = new UsernameRepairSweeper({ownership: failing, config, now: () => now});
			expect(await sweeper.run()).toMatchObject({failed: 1});
			now += 1000;
			expect(await sweeper.run()).toMatchObject({failed: 0, deferred: 1});
			expect(attempts).toBe(1);
			now += 30000;
			expect(await sweeper.run()).toMatchObject({failed: 1});
			now += 30000;
			expect(await sweeper.run()).toMatchObject({failed: 0, deferred: 1});
			expect(attempts).toBe(2);
			await ownership.repository.deleteIntent(uid, 'failure', new Date(now - 122000));
			await new OwnershipInvariants(db).converged();
		},
	);
	it('orphan intent fences a delayed acquire before intent deletion', async () => {
		const repository = new UsernameOwnershipRepository();
		const old = await repository.ensureOwner(uid);
		await repository.writeIntent(uid, 'delayed', new Date(now - 61000));
		await new UsernameRepairSweeper({ownership, config, now: () => now}).run();
		const fenced = await repository.readOwner(uid);
		expect(fenced!.version).toBeGreaterThan(old.version);
		expect((await repository.casOwner(old, {op_id: 'delayed', op_phase: 'pending'}))!.op_id).toBeNull();
		expect(await db.executeQuery(UsernameOpIntents.select().bind({}))).toEqual([]);
		await new OwnershipInvariants(db).converged();
	});
	it('first cursor is yesterday and persisted old day survives a three-day outage', async () => {
		const repository = ownership.repository;
		await repository.ensureOwner(uid);
		await repository.writeIntent(uid, 'old', new Date(now - 61000));
		state = {cursor_day: '2099-10-08', cursor_bucket: 0, after_user_id: null, after_op_id: null};
		now += 3 * 86400000;
		await new UsernameRepairSweeper({ownership, config, now: () => now}).run();
		expect(await db.executeQuery(UsernameOpIntents.select().bind({}))).toEqual([]);
		expect(state!.oldest_day).toBe('2099-10-12');
		expect(state!.cursor_day).toBe('2099-10-13');
		await new OwnershipInvariants(db).converged();
	});
	it('deletes an intent written under an earlier bucket formula and advances the cursor', async () => {
		const repository = ownership.repository;
		await repository.ensureOwner(uid);
		const at = new Date(now - 61000);
		const legacyBucket = Number(uid % 64n);
		expect(intentBucket(uid)).not.toBe(legacyBucket);
		await executeQuery(
			UsernameOpIntents.upsertAll({
				bucket: legacyBucket,
				day: intentDay(at),
				user_id: uid,
				op_id: 'legacy',
				created_at: at,
			}),
		);
		state = {cursor_day: '2099-10-08', cursor_bucket: 0, after_user_id: null, after_op_id: null};
		now += 3 * 86400000;
		await new UsernameRepairSweeper({ownership, config, now: () => now}).run();
		expect(await db.executeQuery(UsernameOpIntents.select().bind({}))).toEqual([]);
		expect(state!.oldest_day).toBe('2099-10-12');
		await new OwnershipInvariants(db).converged();
	});
	it('twenty-second budget persists cursor and next run resumes', async () => {
		const repository = ownership.repository;
		await repository.ensureOwner(uid);
		await repository.writeIntent(uid, 'budget', new Date(now - 61000));
		let ticks = 0;
		const sweeper = new UsernameRepairSweeper({ownership, config, now: () => now + ticks++ * 11000});
		const result = await sweeper.run();
		expect(result.budgetExceeded).toBe(true);
		expect(state).not.toBeNull();
		await new UsernameRepairSweeper({ownership, config, now: () => now}).run();
		expect(await db.executeQuery(UsernameOpIntents.select().bind({}))).toEqual([]);
		await new OwnershipInvariants(db).converged();
	});
	it('young lower-bucket intent cannot block an old later-bucket repair', async () => {
		const repository = ownership.repository;
		const young = createUserID(64n);
		await repository.ensureOwner(young);
		await repository.ensureOwner(uid);
		await repository.writeIntent(young, 'young', new Date(now));
		await repository.writeIntent(uid, 'old', new Date(now - 61000));
		await new UsernameRepairSweeper({ownership, config, now: () => now}).run();
		expect(await db.executeQuery(UsernameOpIntents.select().bind({}))).toMatchObject([{op_id: 'young'}]);
	});
	it('five-thousand row budget persists the last cluster key and resumes without a scan', async () => {
		const repository = ownership.repository;
		await repository.ensureOwner(uid);
		for (let index = 0; index < 5001; index++)
			await repository.writeIntent(uid, `budget_${index.toString().padStart(5, '0')}`, new Date(now - 61000));
		const result = await new UsernameRepairSweeper({ownership, config, now: () => now}).run();
		expect(result).toMatchObject({processed: 5000, budgetExceeded: true});
		expect(state!.after_op_id).toBe('budget_04999');
		expect(await db.executeQuery(UsernameOpIntents.select().bind({}))).toHaveLength(1);
		await new UsernameRepairSweeper({ownership, config, now: () => now}).run();
		await new OwnershipInvariants(db).converged();
	});
});
