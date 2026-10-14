// SPDX-License-Identifier: AGPL-3.0-or-later
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {fetchMany, setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {UserByUsername, UsernameOwners, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {registerUserAccountWriteHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {FakeUsernamePolicyService} from '@app/api/user/username/tests/FakeUsernamePolicyService';
import {emptyOwner} from '@app/api/user/username/UsernameOwnershipRepository';
import {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {UserAccountRepository} from './UserAccountRepository';
import {UserLookupRepository} from './UserLookupRepository';

const id = createUserID(1000000000000000000n);
const row = {...EMPTY_USER_ROW, user_id: id, username: 'owned', discriminator: 1234, flags: 0n, version: 1};
let state: 'legacy' | 'preparing' | 'selecting';
beforeEach(async () => {
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	state = 'legacy';
	vi.spyOn(InstanceConfigRepository.prototype, 'readUsernameMigrationConfig').mockImplementation(async () => ({
		state,
		epoch: 1,
		started_at: null,
		forced_at: null,
	}));
	await upsertOne(Users.upsertAll(row));
});
afterEach(() => {
	vi.restoreAllMocks();
	setCassandraQueryExecutorForTesting(null);
});
test('legacy identity and profile commit in one versioned write with hooks and username index', async () => {
	const repository = new UserAccountRepository(new MockKVProvider());
	const hook = vi.fn(async () => {});
	const unregister = registerUserAccountWriteHook('profile', hook);
	try {
		const user = await repository.patchUpsert(
			id,
			{username: 'next', discriminator: 42, bio: 'profile'},
			row,
			Date.now() + 30000,
		);
		expect([user.username, user.discriminator, user.bio, user.version]).toEqual(['next', 42, 'profile', 2]);
		expect(hook).toHaveBeenCalledTimes(1);
		const names = await fetchMany<{username: string}>(UserByUsername.select().bind({}));
		expect(names.map((name) => name.username)).toEqual(['next']);
	} finally {
		unregister();
	}
});
test('account writer and flags return verified identity metadata', async () => {
	state = 'selecting';
	await upsertOne(UsernameOwners.upsertAll({...emptyOwner(id), username: 'owned', owned_gen: 7n, version: 1}));
	const selected = {...row, discriminator: 0, username_state: 'selected' as const, identity_version: 7n};
	await upsertOne(Users.upsertAll(selected));
	const repo = new UserAccountRepository(new MockKVProvider());
	expect((await repo.patchUpsert(id, {bio: 'profile'}, selected)).identityVersion).toBe(7n);
	expect((await repo.upsert({...selected, bio: 'full'}, selected)).identityVersion).toBe(7n);
	const user = await repo.findUniqueAssert(id);
	expect((await repo.compareAndSetFlags(user, 1n))?.identityVersion).toBe(7n);
});
test('account creation uses the explicit nonzero legacy writer', async () => {
	state = 'selecting';
	const repo = new UserAccountRepository(new MockKVProvider());
	const other = createUserID(id + 1n);
	expect((await repo.create({...row, user_id: other})).username).toBe('owned');
	await expect(repo.create({...row, user_id: createUserID(id + 2n), discriminator: 0})).rejects.toThrow();
});
test.each(['preparing', 'selecting'] as const)(
	'creation writes the first legacy tag exactly once in %s while profile sync stays closed',
	async (migration) => {
		state = migration;
		const queries: Array<string> = [];
		setCassandraQueryExecutorForTesting(
			new InMemoryCassandraQueryExecutor({
				beforeQuery: (query) => {
					if (query.cql.includes('users_by_username') && !query.cql.startsWith('SELECT')) queries.push(query.cql);
				},
			}),
		);
		const repo = new UserAccountRepository(new MockKVProvider());
		const other = createUserID(id + 1n);
		const user = await repo.create({...row, user_id: other});
		const lookup = new UserLookupRepository((userId) => repo.findUnique(userId), {} as never);
		expect((await lookup.findByUsernameDiscriminator(user.username, user.discriminator))?.id).toBe(other);
		expect(queries).toHaveLength(1);
		await repo.patchUpsert(other, {bio: 'profile'});
		expect(queries).toHaveLength(1);
	},
);
test('a delayed initial legacy index cannot undo selection C12 cleanup', async () => {
	state = 'selecting';
	const backend = Config.database.backend;
	Config.database.backend = 'cassandra';
	const other = createUserID(id + 1n);
	let delayed = false;
	const ownership = new UsernameOwnershipService({
		policy: new FakeUsernamePolicyService(),
		clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
		admit: async () => true,
		propagate: async () => {},
		neutralDiscriminator: async () => 1234,
	});
	setCassandraQueryExecutorForTesting(
		new InMemoryCassandraQueryExecutor({
			beforeQuery: async (query) => {
				if (
					!delayed &&
					query.kvMeta?.table.name === 'users_by_username' &&
					query.kvMeta.action === 'upsert' &&
					query.params.discriminator === 1234
				) {
					delayed = true;
					await new Promise((resolve) => setTimeout(resolve, 5));
					expect(await ownership.claimSelf(other, 'selectedname')).toMatchObject({ok: true});
				}
			},
		}),
	);
	try {
		await new UserAccountRepository(new MockKVProvider()).create({...row, user_id: other});
		expect(delayed).toBe(true);
		expect(await ownership.repository.hasIndex(other, 'owned', 1234)).toBe(false);
		expect(await ownership.repository.hasIndex(other, 'selectedname', 0)).toBe(true);
	} finally {
		Config.database.backend = backend;
	}
});
test.each(['zero tag', 'expired'] as const)(
	'rejected %s legacy identity never commits credentials',
	async (rejection) => {
		const repo = new UserAccountRepository(new MockKVProvider());
		await expect(
			repo.patchUpsert(
				id,
				{
					username: 'next',
					...(rejection === 'zero tag' ? {discriminator: 0} : {}),
					password_hash: 'new-password',
					email: 'new@example.com',
				},
				row,
				rejection === 'expired' ? Date.now() - 1 : Date.now() + 30000,
			),
		).rejects.toThrow();
		const user = await repo.findUniqueAssert(id);
		expect(user.passwordHash).toBeNull();
		expect(user.email).toBeNull();
	},
);
