// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {executeQuery, setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {UserByUsername, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';
import {OwnershipInvariants} from './OwnershipInvariants';

const uid = createUserID(200n);
let backend: 'cassandra' | 'postgres';
let now: number;
let db: InMemoryCassandraQueryExecutor;
let ownership: UsernameOwnershipService;
let invariant: OwnershipInvariants;

beforeEach(async () => {
	backend = Config.database.backend;
	Config.database.backend = 'cassandra';
	now = Date.now();
	db = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(db);
	invariant = new OwnershipInvariants(db, () => now);
	ownership = new UsernameOwnershipService({
		policy: new FakeUsernamePolicyService(),
		now: () => now,
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
	await executeQuery(
		Users.patchByPk(
			{user_id: uid},
			{username: Db.set('legacy'), discriminator: Db.set(4567)},
			{timestamp: BigInt(now) * 1000n - 100n},
		),
	);
});
afterEach(() => {
	Config.database.backend = backend;
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
});

describe('C14 effective index timestamp', () => {
	it.each(['username', 'discriminator', 'user_id'] as const)(
		'current index schema cannot select WRITETIME(%s)',
		(column) => {
			expect(() => UserByUsername.select({writeTime: {[column]: 'index_time'}})).toThrow(
				'WRITETIME requires a non-primary-key column',
			);
		},
	);
	it('a legacy row marker ahead of user cells is removed within the bounded projection retry', async () => {
		const ahead = BigInt(now) * 1000n + 999999n;
		await executeQuery(
			UserByUsername.upsertAll({username: 'legacy', discriminator: 4567, user_id: uid}, {timestamp: ahead}),
		);
		const result = await ownership.claimSelf(uid, 'first');
		await invariant.instant();
		expect(result).toMatchObject({ok: true});
		expect(await ownership.repository.hasIndex(uid, 'legacy', 4567)).toBe(false);
		expect((await ownership.repository.readOwner(uid))!.last_proj_ts).toBeGreaterThan(ahead);
		await invariant.converged();
	});
	it('an invisible new-index tombstone is overcome within the bounded projection retry', async () => {
		const ahead = BigInt(now) * 1000n + 999999n;
		await executeQuery(
			UserByUsername.deleteByPk({username: 'first', discriminator: 0, user_id: uid}, {timestamp: ahead}),
		);
		const result = await ownership.claimSelf(uid, 'first');
		await invariant.instant();
		expect(result).toMatchObject({ok: true});
		expect(await ownership.repository.hasIndex(uid, 'first', 0)).toBe(true);
		expect((await ownership.repository.readOwner(uid))!.last_proj_ts).toBeGreaterThan(ahead);
		await invariant.converged();
	});
});
