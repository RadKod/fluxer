// SPDX-License-Identifier: AGPL-3.0-or-later
import {randomUUID} from 'node:crypto';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {
	executeConditional,
	executeQuery,
	hasDatabaseQueryExecutor,
	setCassandraQueryExecutorForTesting,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {UserByUsername, UsernameClaims, UsernameEntitlements, UsernameOwners, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {initCassandra, shutdownCassandra} from '@pkgs/cassandra/src/Client';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {UsernameOwnershipService} from '../UsernameOwnershipService';
import {FakeUsernamePolicyService} from './FakeUsernamePolicyService';

// Micup: this opt-in suite requires an approved disposable Cassandra keyspace with the target schema.
describe.skipIf(process.env.USERNAME_CASSANDRA_TEST !== '1')('real Cassandra username Paxos', () => {
	const prefix = `test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
	const base = BigInt(Date.now()) << 22n;
	const ids: Array<UserID> = [];
	const names = new Set<string>();
	const ownership = new UsernameOwnershipService({
		policy: new FakeUsernamePolicyService(),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
	let backend: 'cassandra' | 'postgres';
	beforeAll(async () => {
		backend = Config.database.backend;
		const expected = process.env.USERNAME_CASSANDRA_TEST_KEYSPACE;
		if (
			!expected ||
			!/^fluxer_username_test_[a-z0-9_]+$/.test(expected) ||
			Config.cassandra.keyspace !== expected ||
			backend !== 'cassandra'
		)
			throw new Error('An explicit disposable Cassandra username test keyspace is required');
		setCassandraQueryExecutorForTesting(null);
		if (hasDatabaseQueryExecutor()) throw new Error('Real Cassandra tests cannot use a configured query executor');
		await initCassandra({
			hosts: Config.cassandra.hosts.split(','),
			port: Config.cassandra.port,
			keyspace: Config.cassandra.keyspace,
			localDc: Config.cassandra.localDc,
			username: Config.cassandra.username || undefined,
			password: Config.cassandra.password || undefined,
			consistency: Config.cassandra.consistency,
		});
	});
	async function seed(index: number): Promise<UserID> {
		const userId = createUserID(base + BigInt(index));
		ids.push(userId);
		await executeQuery(Users.patchByPk({user_id: userId}, {username: Db.set('legacy'), discriminator: Db.set(1234)}));
		return userId;
	}
	it('200 concurrent same-name claims have exactly one durable owner', async () => {
		const name = `${prefix}_race`;
		names.add(name);
		const users = await Promise.all(Array.from({length: 200}, (_, i) => seed(i)));
		const result = await Promise.all(users.map((userId) => ownership.claimSelf(userId, name)));
		expect(result.filter((claim) => claim.ok)).toHaveLength(1);
		for (const userId of users) await ownership.repair(userId);
		const claim = await ownership.repository.readClaim(name);
		expect(claim?.state).toBe('assigned');
		const winner = (await ownership.repository.readOwner(claim!.user_id!))!;
		expect(winner).toMatchObject({username: name, owned_gen: claim!.owned_gen, op_id: null});
		expect(await ownership.repository.readProjection(winner.user_id)).toMatchObject({
			username: name,
			discriminator: 0,
			username_state: 'selected',
		});
	}, 120000);
	it('two concurrent names for one account commit exactly one generation', async () => {
		const userId = await seed(201);
		const first = `${prefix}_one`;
		const second = `${prefix}_two`;
		names.add(first);
		names.add(second);
		const results = await Promise.all([ownership.claimSelf(userId, first), ownership.claimSelf(userId, second)]);
		expect(results.filter((claim) => claim.ok)).toHaveLength(1);
		await ownership.repair(userId);
		expect((await ownership.repository.readOwner(userId))!.owned_gen).toBe(1n);
	});
	afterAll(async () => {
		try {
			for (const name of names) {
				const row = await ownership.repository.readClaim(name);
				if (row)
					await executeConditional(
						UsernameClaims.conditionalDeleteByPk(
							{username: name},
							{version: row.version, op_id: row.op_id, state: row.state},
						),
					);
			}
			for (const userId of ids) {
				const row = await ownership.repository.readOwner(userId);
				if (row)
					await executeConditional(
						UsernameOwners.conditionalDeleteByPk({user_id: userId}, {version: row.version, op_id: row.op_id}),
					);
				const grant = await ownership.repository.readEntitlement(userId);
				if (grant)
					await executeConditional(
						UsernameEntitlements.conditionalDeleteByPk({user_id: userId}, {version: grant.version}),
					);
				for (const name of names)
					await executeQuery(UserByUsername.deleteByPk({username: name, discriminator: 0, user_id: userId}));
				await executeQuery(Users.deleteByPk({user_id: userId}));
			}
		} finally {
			await shutdownCassandra();
			Config.database.backend = backend;
			setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		}
	});
});
