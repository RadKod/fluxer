// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createDefaultLimitConfig} from '@app/api/constants/LimitConfig';
import {setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import * as LimitConfig from '@app/api/limits/LimitConfigService';
import {setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {UserSearchRepository} from '@app/api/user/repositories/account/crud/UserSearchRepository';
import {UserAccountRepository} from '@app/api/user/repositories/account/UserAccountRepository';
import * as PartialUserChangePropagation from '@app/api/user/services/PartialUserChangePropagation';
import {UserAccountService} from '@app/api/user/services/UserAccountService';
import {FakeUsernamePolicyService} from '@app/api/user/username/tests/FakeUsernamePolicyService';
import {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

const id = createUserID(1174109840998400011n);
let backend: typeof Config.database.backend;

beforeEach(async () => {
	backend = Config.database.backend;
	Config.database.backend = 'cassandra';
	vi.spyOn(LimitConfig, 'getGlobalLimitConfigSnapshot').mockReturnValue(
		createDefaultLimitConfig({selfHosted: true, premiumMode: 'everyone'}),
	);
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	await upsertOne(
		Users.upsertAll({...EMPTY_USER_ROW, user_id: id, username: 'legacy', discriminator: 4567, version: 1}),
	);
	setInjectedUsernameOwnershipService(
		new UsernameOwnershipService({
			policy: new FakeUsernamePolicyService(),
			clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
			admit: async () => true,
			propagate: async () => {},
			neutralDiscriminator: async () => 1234,
		}),
	);
});
afterEach(() => {
	Config.database.backend = backend;
	setInjectedUsernameOwnershipService(undefined);
	setCassandraQueryExecutorForTesting(null);
	vi.restoreAllMocks();
});

test('a successful selection answers, indexes and dispatches the projected identity', async () => {
	const repository = new UserAccountRepository(new MockKVProvider());
	const searched = vi.spyOn(UserSearchRepository.prototype, 'updateUser').mockResolvedValue();
	const propagated = vi.spyOn(PartialUserChangePropagation, 'propagateUserUpdate').mockResolvedValue();
	const service: UserAccountService = Object.assign(Object.create(UserAccountService.prototype), {
		apiContext: {services: {worker: {addJob: vi.fn().mockResolvedValue(1n)}}},
		userAccountRepository: repository,
		guildRepository: {},
		profileService: {processProfileUpdates: vi.fn().mockResolvedValue({updates: {}}), commitAssetChanges: vi.fn()},
		securityService: {
			processSecurityUpdates: vi.fn().mockResolvedValue({updates: {}, metadata: {usernameClaim: 'chosen'}}),
		},
		contactChangeLogService: {recordDiff: vi.fn()},
		userUpdateDeps: {},
		searchIndexService: {updateUserMembers: vi.fn()},
	});
	const user = await repository.findUniqueAssert(id);
	const result = await service.update({
		user,
		oldAuthSession: {} as never,
		data: {username: 'chosen'},
		request: new Request('http://localhost/'),
	});
	const projected = {username: 'chosen', discriminator: 0, usernameState: 'selected', identityVersion: 1n};
	expect(result.user).toMatchObject(projected);
	expect(propagated.mock.calls.at(-1)?.[2]).toMatchObject(projected);
	expect(searched.mock.calls.at(-1)?.[0]).toMatchObject(projected);
	expect(await repository.findUniqueAssert(id)).toMatchObject(projected);
});
