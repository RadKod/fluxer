// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getConfig} from '@app/api/Config';
import {fetchMany, setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {
	getCachedAccountIdentity,
	getFreshCachedAccountIdentity,
	setCachedAccountIdentity,
} from '@app/api/instance/AccountIdentityModeCache';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {LimitConfigService, resetGlobalLimitConfigServiceForTesting} from '@app/api/limits/LimitConfigService';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {setInjectedUsernameOwnershipService} from '@app/api/middleware/ServiceRegistry';
import {User} from '@app/api/models/User';
import {RpcSessionStartService} from '@app/api/rpc/RpcSessionStartService';
import type {UserData} from '@app/api/rpc/RpcTypes';
import {UsernameOpIntents, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {UserRepository} from '@app/api/user/repositories/UserRepository';
import {FakeUsernamePolicyService} from '@app/api/user/username/tests/FakeUsernamePolicyService';
import {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {AccountIdentityModes, TagStyles} from '@fluxer/constants/src/AccountIdentityConstants';
import {PremiumFlags, UserFlags} from '@fluxer/constants/src/UserConstants';
import {InMemoryProvider} from '@pkgs/cache/src/providers/InMemoryProvider';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

describe('username migration READY repair', () => {
	const originalSelfHosted = getConfig().instance.selfHosted;
	beforeAll(() => {
		getConfig().instance.selfHosted = true;
	});
	afterAll(() => {
		getConfig().instance.selfHosted = originalSelfHosted;
	});
	beforeAll(() => {
		new LimitConfigService(new InstanceConfigRepository(), new InMemoryProvider()).setAsGlobalInstance();
	});
	afterAll(() => {
		resetGlobalLimitConfigServiceForTesting();
	});
	afterEach(() => {
		setCachedAccountIdentity(null);
		setInjectedUsernameOwnershipService(undefined);
		vi.restoreAllMocks();
	});
	function start(outcome: () => Promise<boolean>, state: 'preparing' | 'selecting' = 'selecting') {
		setCachedAccountIdentity({
			mode: AccountIdentityModes.EMAIL,
			tagStyle: TagStyles.RANDOM,
			usernameMigration: {state, epoch: 1, started_at: null, forced_at: null},
		});
		const user = new User({
			...EMPTY_USER_ROW,
			user_id: createUserID(123n),
			username: 'legacy',
			discriminator: 1234,
			flags: UserFlags.HAS_SESSION_STARTED,
			premium_flags: PremiumFlags.DISCRIMINATOR,
		});
		const repair = vi.fn(outcome);
		setInjectedUsernameOwnershipService({repair} as unknown as UsernameOwnershipService);
		const generateDiscriminator = vi.fn().mockResolvedValue({available: true, discriminator: 4321});
		const findUniqueAssert = vi.fn().mockResolvedValue(user);
		const service = new RpcSessionStartService({
			userRepository: {
				findUniqueAssert,
				patchUpsert: vi.fn().mockResolvedValue(user),
				updateFlags: vi.fn(),
				findSettings: vi.fn().mockResolvedValue(null),
			},
			guildRepository: {},
			userCacheService: {},
			gatewayService: {},
			discriminatorService: {generateDiscriminator},
		} as never);
		const run = service.processSessionStart({
			userData: {user, settings: null, guildIds: []} as unknown as UserData,
			requestCache: createRequestCache(),
			geoipCountryIso: null,
			clientIp: null,
		});
		return {run, user, repair, findUniqueAssert, generateDiscriminator};
	}
	it.each([
		{state: 'preparing', hosted: true},
		{state: 'selecting', hosted: true},
		{state: 'selecting', hosted: false},
	] as const)('repairs active migration and skips human premium discriminator reset in %s', async ({state, hosted}) => {
		getConfig().instance.selfHosted = hosted;
		const {run, user, repair, findUniqueAssert, generateDiscriminator} = start(async () => true, state);
		await run;
		expect(repair).toHaveBeenCalledWith(user.id);
		expect(findUniqueAssert).toHaveBeenCalledWith(user.id);
		expect(generateDiscriminator).not.toHaveBeenCalled();
	});
	it('rereads the user only when the owner had an operation to repair', async () => {
		const {run, findUniqueAssert} = start(async () => false);
		await run;
		expect(findUniqueAssert).not.toHaveBeenCalled();
	});
	it('starts the session when repair fails and leaves the intent to the sweeper', async () => {
		const {run, findUniqueAssert} = start(async () => {
			throw new Error('Paxos timeout');
		});
		await expect(run).resolves.toBeDefined();
		expect(findUniqueAssert).not.toHaveBeenCalled();
	});
});

describe('identity snapshot without a config subscription', () => {
	const originalSelfHosted = getConfig().instance.selfHosted;
	afterEach(() => {
		getConfig().instance.selfHosted = originalSelfHosted;
		setCachedAccountIdentity(null);
		setCassandraQueryExecutorForTesting(null);
		vi.restoreAllMocks();
	});
	it('a stale legacy snapshot cannot write identity after the preparation barrier', async () => {
		getConfig().instance.selfHosted = true;
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		const id = createUserID(1000000000000000123n);
		await upsertOne(
			Users.upsertAll({
				...EMPTY_USER_ROW,
				user_id: id,
				username: 'legacy',
				discriminator: 1234,
				flags: UserFlags.HAS_SESSION_STARTED,
				premium_flags: PremiumFlags.DISCRIMINATOR,
				version: 1,
			}),
		);
		const preparer = new InstanceConfigRepository();
		const subscriptionless = new InstanceConfigRepository();
		await preparer.setConfig(
			'account_identity_config',
			JSON.stringify({
				mode: 'email',
				tag_style: 'random',
				source: 'existing_instance',
				decided_at: '2026-10-09T00:00:00Z',
			}),
		);
		await subscriptionless.getAccountIdentity();
		const prepared = await preparer.prepareUsernameMigration({processesReady: true});
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse(prepared.preparing_at!) + 61_000);
		// Micup: hosted premium rules make the legacy premium tag reset reachable.
		getConfig().instance.selfHosted = false;
		const users = new UserRepository(new MockKVProvider());
		const service = new RpcSessionStartService({
			userRepository: users,
			guildRepository: {},
			userCacheService: {setUserPartialResponseFromUserInBackground: vi.fn()},
			gatewayService: {},
			discriminatorService: {generateDiscriminator: vi.fn().mockResolvedValue({available: true, discriminator: 4321})},
		} as never);
		await service.processSessionStart({
			userData: {user: await users.findUniqueAssert(id), settings: null, guildIds: []} as unknown as UserData,
			requestCache: createRequestCache(),
			geoipCountryIso: null,
			clientIp: null,
		});
		expect((await users.findUniqueAssert(id)).discriminator).toBe(1234);
		await subscriptionless.getConfig('username_policy');
		expect(getCachedAccountIdentity().usernameMigration?.state).toBe('preparing');
		await Promise.all([preparer.shutdown(), subscriptionless.shutdown()]);
	});
	function identityReadsThrough(onIdentityRead: () => Promise<void>) {
		const base = new InMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting({
			async executeQuery<T = Record<string, unknown>>(query: PreparedQuery, options?: never): Promise<Array<T>> {
				if (query.params?.key === 'account_identity_config' && /^\s*SELECT/i.test(query.cql)) await onIdentityRead();
				return base.executeQuery<T>(query, options);
			},
			executeBatch: (queries, atomic) => base.executeBatch(queries, atomic),
		});
	}
	it('concurrent direct reads share one identity refresh', async () => {
		let identityReads = 0;
		let release!: () => void;
		const delayed = new Promise<void>((resolve) => {
			release = resolve;
		});
		identityReadsThrough(async () => {
			identityReads++;
			await delayed;
		});
		const repository = new InstanceConfigRepository();
		setCachedAccountIdentity(null, 0);
		const reads = Promise.all(Array.from({length: 100}, () => repository.getConfig('username_policy')));
		await new Promise((resolve) => setTimeout(resolve, 20));
		release();
		await reads;
		expect(identityReads).toBe(1);
		await repository.getConfig('username_policy');
		expect(identityReads).toBe(1);
		await repository.shutdown();
	});
	it('an identity refresh failure returns the requested config and keeps identity writers closed', async () => {
		let identityReads = 0;
		identityReadsThrough(async () => {
			identityReads++;
			throw new Error('identity read timeout');
		});
		const repository = new InstanceConfigRepository();
		await repository.setConfig('username_policy', 'stored');
		setCachedAccountIdentity({mode: AccountIdentityModes.EMAIL, tagStyle: TagStyles.RANDOM}, Date.now() - 11_000);
		// Move past the shared refresh window left by the previous test so the refresh really runs and fails.
		const realNow = Date.now();
		vi.spyOn(Date, 'now').mockReturnValue(realNow + 2_000);
		await expect(repository.getConfig('username_policy')).resolves.toBe('stored');
		expect(identityReads).toBe(1);
		vi.restoreAllMocks();
		expect(getFreshCachedAccountIdentity()).toBeNull();
		expect(getCachedAccountIdentity().mode).toBe(AccountIdentityModes.EMAIL);
		await repository.shutdown();
	});
});

describe('READY repair that fails after projection', () => {
	const backend = getConfig().database.backend;
	afterEach(() => {
		getConfig().database.backend = backend;
		setCachedAccountIdentity(null);
		setInjectedUsernameOwnershipService(undefined);
		setCassandraQueryExecutorForTesting(null);
		vi.restoreAllMocks();
	});
	it('rereads the projected identity when only the final intent deletion fails', async () => {
		getConfig().database.backend = 'cassandra';
		let failAssign = true;
		let failIntentDelete = false;
		setCassandraQueryExecutorForTesting(
			new InMemoryCassandraQueryExecutor({
				beforeQuery: (query: PreparedQuery) => {
					const table = query.kvMeta?.table.name;
					if (failAssign && table === 'username_claims' && query.params.state === 'assigned')
						throw new Error('claim assignment unavailable');
					if (failIntentDelete && table === 'username_op_intents' && query.kvMeta?.action === 'delete')
						throw new Error('intent deletion unavailable');
				},
			}),
		);
		const id = createUserID(1000000000000000124n);
		await upsertOne(
			Users.upsertAll({
				...EMPTY_USER_ROW,
				user_id: id,
				username: 'legacy',
				discriminator: 1234,
				flags: UserFlags.HAS_SESSION_STARTED,
				version: 1,
			}),
		);
		const ownership = new UsernameOwnershipService({
			policy: new FakeUsernamePolicyService(),
			clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
			admit: async () => true,
			propagate: async () => {},
			neutralDiscriminator: async () => 1234,
		});
		expect(await ownership.claimSelf(id, 'chosen')).toEqual({ok: false, code: 'UNAVAILABLE'});
		expect(await ownership.repository.readOwner(id)).toMatchObject({op_phase: 'committed', op_new: 'chosen'});
		failAssign = false;
		failIntentDelete = true;
		setInjectedUsernameOwnershipService(ownership);
		setCachedAccountIdentity({
			mode: AccountIdentityModes.EMAIL,
			tagStyle: TagStyles.RANDOM,
			usernameMigration: {state: 'selecting', epoch: 1, started_at: null, forced_at: null},
		});
		const users = new UserRepository(new MockKVProvider());
		const userData = {user: await users.findUniqueAssert(id), settings: null, guildIds: []} as unknown as UserData;
		const result = await new RpcSessionStartService({
			userRepository: users,
			guildRepository: {},
			userCacheService: {},
			gatewayService: {},
			discriminatorService: {generateDiscriminator: vi.fn()},
		} as never).processSessionStart({
			userData,
			requestCache: createRequestCache(),
			geoipCountryIso: null,
			clientIp: null,
		});
		expect(await ownership.repository.readOwner(id)).toMatchObject({op_id: null});
		expect(await fetchMany(UsernameOpIntents.select().bind({}))).toHaveLength(1);
		expect(result.user).toMatchObject({username: 'chosen', discriminator: 0, usernameState: 'selected'});
		expect(userData.user).toBe(result.user);
	});
});
