// SPDX-License-Identifier: AGPL-3.0-or-later
import {createUserID} from '@app/api/BrandedTypes';
import {fetchMany, setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {UserByEmail, UserByUsername, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {UserDataRepository} from './UserDataRepository';
import {UserIndexRepository} from './UserIndexRepository';

const id = createUserID(1000000000000000000n);
const row = {
	...EMPTY_USER_ROW,
	user_id: id,
	username: 'owned',
	discriminator: 1234,
	username_state: null,
	email: 'before@example.com',
	flags: 0n,
	version: 1,
};
let executor: InMemoryCassandraQueryExecutor;
let state: 'legacy' | 'preparing' | 'selecting';
beforeEach(async () => {
	executor = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(executor);
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
describe.each(['legacy', 'preparing', 'selecting'] as const)('%s human writer contract', (mode) => {
	test('generic patch does not rewrite human identity', async () => {
		state = mode;
		const repo = new UserDataRepository();
		const result = await repo.patchUser(
			id,
			{
				username: Db.set('stale'),
				discriminator: Db.set(0),
				username_state: Db.set('selected'),
				identity_version: Db.set(99n),
				bio: Db.set('profile'),
			},
			row,
		);
		const stored = await repo.findUniqueAssert(id);
		expect([stored.username, stored.discriminator, stored.toRow().username_state]).toEqual(['owned', 1234, null]);
		expect(result.updatedData.username).toBe('owned');
		expect(stored.identityVersion).toBe(0n);
		expect(stored.bio).toBe('profile');
	});
	test('generic full upsert does not rewrite human identity', async () => {
		state = mode;
		const repo = new UserDataRepository();
		const result = await repo.upsertUserRow(
			{...row, username: 'stale', discriminator: 0, username_state: 'selected', identity_version: 99n, bio: 'profile'},
			row,
		);
		expect((await repo.findUniqueAssert(id)).username).toBe('owned');
		expect((await repo.findUniqueAssert(id)).identityVersion).toBe(0n);
		expect(result.updatedData.username).toBe('owned');
	});
	test('generic index sync touches the username key only when the identity changed', async () => {
		state = mode;
		await new UserIndexRepository().syncIndices({...row, email: 'next@example.com'}, row);
		expect(await fetchMany(UserByUsername.select().bind({}))).toEqual([]);
		expect((await fetchMany(UserByEmail.select().bind({}))).length).toBe(1);
		await new UserIndexRepository().syncIndices({...row, username: 'next'}, row);
		expect((await fetchMany<{username: string}>(UserByUsername.select().bind({}))).map((key) => key.username)).toEqual([
			'next',
		]);
	});
	test('deletion LWT cannot rewrite identity', async () => {
		state = mode;
		const repo = new UserDataRepository();
		const started = {...row, pending_deletion_at: new Date(1), deletion_started_at: new Date(2)};
		await upsertOne(Users.upsertAll(started));
		const result = await repo.patchDeletion(
			await repo.findUniqueAssert(id),
			{username: Db.set('stale'), discriminator: Db.set(0), bio: Db.clear()},
			'anonymise',
		);
		expect(result.updatedData.username).toBe('owned');
		expect((await repo.findUniqueAssert(id)).username).toBe('owned');
	});
});
test('bot generic patch preserves tagged identity exception', async () => {
	await upsertOne(Users.patchByPk({user_id: id}, {bot: Db.set(true)}));
	const repo = new UserDataRepository();
	await repo.patchUser(id, {username: Db.set('botname'), discriminator: Db.set(12)});
	expect((await repo.findUniqueAssert(id)).username).toBe('botname');
});
test.each(['legacy', 'preparing', 'selecting'] as const)(
	'explicit creation retains nonzero legacy identity in %s',
	async (mode) => {
		state = mode;
		const repo = new UserDataRepository();
		const newId = createUserID(id + 1n);
		await repo.createUserRow({...row, user_id: newId});
		expect((await repo.findUniqueAssert(newId)).username).toBe('owned');
		await expect(repo.createUserRow({...row, user_id: createUserID(id + 2n), discriminator: 0})).rejects.toThrow();
	},
);
test('explicit legacy identity writes identity and profile in one versioned patch', async () => {
	const repo = new UserDataRepository();
	const result = await repo.patchUser(
		id,
		{username: Db.set('next'), discriminator: Db.set(99), bio: Db.set('profile')},
		row,
		Date.now() + 30000,
	);
	const stored = await repo.findUniqueAssert(id);
	expect([stored.username, stored.discriminator, stored.bio, stored.version]).toEqual(['next', 99, 'profile', 2]);
	expect(result.updatedData).toMatchObject({username: 'next', discriminator: 99, version: 2});
});
test.each([
	['expired deadline', {username: Db.set('next')}, -1],
	['zero tag', {username: Db.set('next'), discriminator: Db.set(0)}, 30000],
	['selection state', {username: Db.set('next'), username_state: Db.set('selected' as const)}, 30000],
] as const)('explicit legacy identity rejects %s', async (_case, patch, deadline) => {
	const repo = new UserDataRepository();
	await expect(repo.patchUser(id, patch, row, Date.now() + deadline)).rejects.toThrow();
	expect((await repo.findUniqueAssert(id)).username).toBe('owned');
});
test('legacy deletion identity deletes its old key before anonymizing', async () => {
	const repo = new UserDataRepository();
	await new UserIndexRepository().syncIndices(row, null);
	await upsertOne(Users.upsertAll({...row, pending_deletion_at: new Date(1), deletion_started_at: new Date(2)}));
	await repo.anonymizeLegacyIdentityForDeletion(await repo.findUniqueAssert(id), Date.now() + 30000);
	expect((await repo.findUniqueAssert(id)).username).toBe('DeletedUser');
	expect(await fetchMany(UserByUsername.select().bind({}))).toEqual([]);
});
test('expired legacy deletion cannot rewrite identity', async () => {
	const repo = new UserDataRepository();
	await upsertOne(Users.upsertAll({...row, pending_deletion_at: new Date(1), deletion_started_at: new Date(2)}));
	await expect(
		repo.anonymizeLegacyIdentityForDeletion(await repo.findUniqueAssert(id), Date.now() - 1),
	).rejects.toThrow();
	expect((await repo.findUniqueAssert(id)).username).toBe('owned');
});
test.each(['legacy', 'preparing', 'selecting'] as const)('bots keep username indices in %s', async (mode) => {
	state = mode;
	await new UserIndexRepository().syncIndices({...row, bot: true});
	expect((await fetchMany(UserByUsername.select().bind({}))).length).toBe(1);
});
test('ownership deletion skips username index and cleans the remaining keys', async () => {
	await new UserIndexRepository().syncIndices(row);
	await new UserIndexRepository().deleteIndices(id, row.username, row.discriminator, row.email, null, null, null, true);
	expect((await fetchMany(UserByUsername.select().bind({}))).length).toBe(1);
	expect((await fetchMany(UserByEmail.select().bind({}))).length).toBe(0);
});
test('stale profile writes keep the stored identity without an extra read', async () => {
	const stale = {...row, username: 'previous'};
	const reads: Array<string> = [];
	setCassandraQueryExecutorForTesting(
		new InMemoryCassandraQueryExecutor({
			beforeQuery: (query) => {
				if (query.cql.startsWith('SELECT')) reads.push(query.cql);
			},
		}),
	);
	await upsertOne(Users.upsertAll(row));
	const repo = new UserDataRepository();
	const patched = await repo.patchUser(id, {bio: Db.set('new')}, stale);
	const upserted = await repo.upsertUserRow({...stale, bio: 'newer'}, stale);
	expect([patched.updatedData.bio, upserted.updatedData.bio]).toEqual(['new', 'newer']);
	expect(reads).toEqual([]);
	expect(await fetchMany(UserByUsername.select().bind({}))).toEqual([]);
	expect((await repo.findUniqueAssert(id)).username).toBe('owned');
});
