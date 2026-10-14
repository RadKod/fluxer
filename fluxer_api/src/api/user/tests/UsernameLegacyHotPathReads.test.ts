// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import type {CassandraReadOptions} from '@app/api/database/CassandraQueryExecution';
import {fetchMany, setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {setCachedAccountIdentity} from '@app/api/instance/AccountIdentityModeCache';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {User} from '@app/api/models/User';
import {RpcSessionStartService} from '@app/api/rpc/RpcSessionStartService';
import type {UserData} from '@app/api/rpc/RpcTypes';
import {UserByUsername, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {UserAccountRepository} from '@app/api/user/repositories/account/UserAccountRepository';
import {resolveUsernameHandle} from '@app/api/user/UniqueUsernames';
import type {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {AccountIdentityModes, TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterEach, beforeEach, expect, test, vi} from 'vitest';

const id = createUserID(1000000000000000001n);
const row = {...EMPTY_USER_ROW, user_id: id, username: 'legacy', discriminator: 1234, flags: 0n, version: 1};
let configSerialReads: number;

function countConfigSerialReads(query: PreparedQuery, options?: CassandraReadOptions): void {
	if (options?.consistency === 'serial' && query.cql.includes('instance_configuration')) configSerialReads++;
}

beforeEach(async () => {
	configSerialReads = 0;
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor({beforeQuery: countConfigSerialReads}));
	setCachedAccountIdentity({mode: AccountIdentityModes.EMAIL, tagStyle: TagStyles.RANDOM});
	await upsertOne(Users.upsertAll(row));
});
afterEach(() => {
	setCachedAccountIdentity(null);
	setInjectedUsernameOwnershipService(undefined);
	setCassandraQueryExecutorForTesting(null);
	vi.restoreAllMocks();
});

test('legacy human profile write reads no username configuration through Paxos', async () => {
	const user = await new UserAccountRepository(new MockKVProvider()).patchUpsert(id, {bio: 'profile'}, row);
	expect(user.bio).toBe('profile');
	expect(configSerialReads).toBe(0);
	expect(await fetchMany(UserByUsername.select().bind({}))).toEqual([]);
});

test('legacy READY reads no username configuration through Paxos and skips repair', async () => {
	const repair = vi.fn();
	setInjectedUsernameOwnershipService({repair} as unknown as UsernameOwnershipService);
	const user = new User({...row, flags: UserFlags.HAS_SESSION_STARTED});
	const findUniqueAssert = vi.fn();
	const service = new RpcSessionStartService({
		userRepository: {
			findUniqueAssert,
			patchUpsert: vi.fn(),
			updateFlags: vi.fn(),
			findSettings: vi.fn().mockResolvedValue(null),
		},
		guildRepository: {},
		userCacheService: {},
		gatewayService: {},
		discriminatorService: {generateDiscriminator: vi.fn()},
	} as never);
	await service.processSessionStart({
		userData: {user, settings: null, guildIds: []} as unknown as UserData,
		requestCache: createRequestCache(),
		geoipCountryIso: null,
		clientIp: null,
	});
	expect(configSerialReads).toBe(0);
	expect(repair).not.toHaveBeenCalled();
	expect(findUniqueAssert).not.toHaveBeenCalled();
});

test('legacy bare-name lookup reads no username claim', async () => {
	const resolveBareName = vi.fn();
	setInjectedUsernameOwnershipService({resolveBareName} as unknown as UsernameOwnershipService);
	const users = {findUnique: vi.fn(), findByUsernameDiscriminator: vi.fn()};
	expect(await resolveUsernameHandle(users, '@ayse')).toBeNull();
	expect(resolveBareName).not.toHaveBeenCalled();
	expect(configSerialReads).toBe(0);
});
