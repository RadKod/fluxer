// SPDX-License-Identifier: AGPL-3.0-or-later
import {createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {MAX_TOKEN, MIN_TOKEN} from '@app/api/database/TokenRangeScan';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {UsernameOwners, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {emptyOwner} from '@app/api/user/username/UsernameOwnershipRepository';
import type {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {afterEach, expect, test, vi} from 'vitest';
import {UserDataRepository} from './UserDataRepository';

const id = createUserID(1000000000000000000n);
const owner = {...emptyOwner(id), username: 'owned', owned_gen: 9n, version: 1};
const row = {
	...EMPTY_USER_ROW,
	user_id: id,
	username: 'owned',
	discriminator: 0,
	username_state: 'selected' as const,
	identity_version: 9n,
	flags: 0n,
	version: 1,
};
afterEach(() => {
	setCassandraQueryExecutorForTesting(null);
	setInjectedUsernameOwnershipService(undefined);
});
test('read pairs identity with its users projection generation', async () => {
	const order: Array<string> = [];
	const executor = new InMemoryCassandraQueryExecutor({
		beforeQuery: (query) => {
			if (query.cql.startsWith('SELECT')) order.push(query.cql.includes('username_owners') ? 'owner' : 'user');
		},
	});
	setCassandraQueryExecutorForTesting(executor);
	await upsertOne(Users.upsertAll(row));
	await upsertOne(UsernameOwners.upsertAll(owner));
	const user = await new UserDataRepository().findUniqueAssert(id);
	expect(user.identityVersion).toBe(9n);
	expect(user.username).toBe('owned');
	expect(order).toEqual(['user']);
});
test('concurrent projection change keeps the returned snapshot generation paired with its identity', async () => {
	let changed = false;
	const executor = new InMemoryCassandraQueryExecutor({
		afterQuery: async (query) => {
			if (!changed && query.cql.startsWith('SELECT') && query.cql.includes('FROM users ')) {
				changed = true;
				await upsertOne(UsernameOwners.upsertAll({...owner, username: 'next', owned_gen: 10n, version: 2}));
				await upsertOne(Users.upsertAll({...row, username: 'next', identity_version: 10n}));
			}
		},
	});
	setCassandraQueryExecutorForTesting(executor);
	await upsertOne(Users.upsertAll(row));
	await upsertOne(UsernameOwners.upsertAll(owner));
	const user = await new UserDataRepository().findUniqueAssert(id);
	expect([user.username, user.identityVersion]).toEqual(['owned', 9n]);
	const next = await new UserDataRepository().findUniqueAssert(id);
	expect([next.username, next.identityVersion]).toEqual(['next', 10n]);
});
test('list results carry the same verified generation', async () => {
	const executor = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(executor);
	await upsertOne(Users.upsertAll(row));
	await upsertOne(UsernameOwners.upsertAll(owner));
	expect((await new UserDataRepository().listUsers([id]))[0].identityVersion).toBe(9n);
	const repo = new UserDataRepository();
	expect((await repo.listAllUsersPaginated(10))[0].identityVersion).toBe(9n);
});
test('maintenance scans preserve raw rows and never read or repair ownership', async () => {
	const reads: Array<string> = [];
	const executor = new InMemoryCassandraQueryExecutor({
		beforeQuery: (query) => {
			if (query.cql.startsWith('SELECT')) reads.push(query.cql);
		},
	});
	setCassandraQueryExecutorForTesting(executor);
	await upsertOne(Users.upsertAll({...row, username: 'previous'}));
	await upsertOne(UsernameOwners.upsertAll(owner));
	const repair = vi.fn(async () => {});
	setInjectedUsernameOwnershipService({repair} as unknown as UsernameOwnershipService);
	const repo = new UserDataRepository();
	const full = await repo.scanAllUsersPage(10);
	const token = await repo.scanUsersTokenRangePage({start: MIN_TOKEN, end: MAX_TOKEN}, 10);
	expect(full.users[0].username).toBe('previous');
	expect(token.users[0].identityVersion).toBe(9n);
	expect(reads).toHaveLength(2);
	expect(reads.some((query) => query.includes('username_owners'))).toBe(false);
	expect(repair).not.toHaveBeenCalled();
	expect(full.pageState).toBeNull();
	expect(token.pageState).toBeNull();
});
test('a committed projection is returned without recursive propagation repair', async () => {
	const executor = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(executor);
	await upsertOne(Users.upsertAll(row));
	await upsertOne(UsernameOwners.upsertAll({...owner, op_id: 'committed', op_phase: 'committed', op_kind: 'self'}));
	const repair = vi.fn();
	setInjectedUsernameOwnershipService({repair} as unknown as UsernameOwnershipService);
	expect((await new UserDataRepository().findUniqueAssert(id)).identityVersion).toBe(9n);
	expect(repair).not.toHaveBeenCalled();
});
test('owner disagreement never relabels the users projection with owner metadata', async () => {
	const executor = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(executor);
	await upsertOne(Users.upsertAll({...row, username: 'previous'}));
	await upsertOne(UsernameOwners.upsertAll(owner));
	const repair = vi.fn(async () => {
		await upsertOne(Users.upsertAll(row));
	});
	setInjectedUsernameOwnershipService({repair} as unknown as UsernameOwnershipService);
	expect((await new UserDataRepository().findUniqueAssert(id)).identityVersion).toBe(9n);
	expect(repair).not.toHaveBeenCalled();
});
test('ordinary reads never invoke ownership repair even when owner differs', async () => {
	const executor = new InMemoryCassandraQueryExecutor();
	setCassandraQueryExecutorForTesting(executor);
	await upsertOne(Users.upsertAll({...row, username: 'previous'}));
	await upsertOne(UsernameOwners.upsertAll(owner));
	const repair = vi.fn(async () => {});
	setInjectedUsernameOwnershipService({repair} as unknown as UsernameOwnershipService);
	expect((await new UserDataRepository().findUniqueAssert(id)).username).toBe('previous');
	expect(repair).not.toHaveBeenCalled();
});
