// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {UsernameClaimRow} from '@app/api/database/types/UserTypes';
import {UsernameHoldsByBucket} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {holdBucket, UsernameOwnershipRepository} from '../UsernameOwnershipRepository';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {UsernameRepairSweeper} from '../UsernameRepairSweeper';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';

let now: number;
let db: InMemoryCassandraQueryExecutor;
let backend: 'cassandra' | 'postgres';
const ctx = {adminId: createUserID(999n), reason: 'test', note: 'test'};
const make = (repository = new UsernameOwnershipRepository()) =>
	new UsernameOwnershipService({
		repository,
		policy: new FakeUsernamePolicyService(),
		now: () => now,
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
const sweep = (ownership: UsernameOwnershipService) => new UsernameRepairSweeper({ownership, now: () => now});
beforeEach(() => {
	backend = Config.database.backend;
	Config.database.backend = 'cassandra';
	now = Date.parse('2099-10-09T12:00:00Z');
	db = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(db);
});
afterEach(() => {
	Config.database.backend = backend;
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});
describe('hold index maintenance', () => {
	it('index-first process crash with no claim is removed after the cleanup grace', async () => {
		class CrashedRepository extends UsernameOwnershipRepository {
			override async insertClaim(): Promise<UsernameClaimRow | null> {
				throw new Error('process stopped');
			}
		}
		await expect(make(new CrashedRepository()).adminHold('first', ctx)).rejects.toThrow('process stopped');
		now += 301000;
		const repair = sweep(make());
		expect(repair).toHaveProperty('cleanupHoldBucket');
		await repair.cleanupHoldBucket(holdBucket('first'));
		expect(await executeQuery(UsernameHoldsByBucket.select().bind({}))).toEqual([]);
	});
	it('speculative index above a released durable timestamp is reconciled before cleanup', async () => {
		const api = make();
		await api.adminHold('first', ctx);
		await api.adminUnhold('first', ctx);
		const claim = (await api.repository.readClaim('first'))!;
		const high = claim.index_ts + 1000000000n;
		const moved = (await api.repository.casClaim(claim, {index_ts: high}))!;
		await api.repository.writeHoldIndex({...moved, index_ts: high + 1n, updated_at: new Date(now)});
		now += 301000;
		const repair = sweep(api);
		expect(repair).toHaveProperty('cleanupHoldBucket');
		await repair.cleanupHoldBucket(holdBucket('first'));
		expect(await executeQuery(UsernameHoldsByBucket.select().bind({}))).toEqual([]);
		expect((await api.repository.readClaim('first'))!.index_ts).toBeGreaterThan(high + 1n);
	});
	it('a delayed cleanup cannot delete a newer hold', async () => {
		const api = make();
		await api.adminHold('first', ctx);
		await api.adminUnhold('first', ctx);
		const claim = (await api.repository.readClaim('first'))!;
		await api.repository.writeHoldIndex({...claim, index_ts: claim.index_ts + 1n});
		now += 301000;
		let release!: () => void;
		let reached!: () => void;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			reached = resolve;
		});
		class PausedCleanupRepository extends UsernameOwnershipRepository {
			override async deleteHoldIndex(row: UsernameClaimRow) {
				reached();
				await wait;
				await super.deleteHoldIndex(row);
			}
		}
		const repair = sweep(make(new PausedCleanupRepository()));
		expect(repair).toHaveProperty('cleanupHoldBucket');
		const cleanup = repair.cleanupHoldBucket(holdBucket('first'));
		await ready;
		await api.adminHold('first', ctx);
		release();
		await cleanup;
		expect(await executeQuery(UsernameHoldsByBucket.select().bind({}))).toHaveLength(1);
		expect(await api.repository.readClaim('first')).toMatchObject({state: 'held'});
	});
});
