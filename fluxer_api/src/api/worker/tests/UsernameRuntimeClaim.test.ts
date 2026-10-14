// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {CassandraReadOptions} from '@app/api/database/CassandraQueryExecution';
import {fetchMany, setCassandraQueryExecutorForTesting, upsertOne} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {InstanceConfigRepository, type UsernamePolicyConfig} from '@app/api/instance/InstanceConfigRepository';
import {LimitConfigService, resetGlobalLimitConfigServiceForTesting} from '@app/api/limits/LimitConfigService';
import {profileSubstringBlocklistCache} from '@app/api/middleware/ProfileSubstringBlocklistCache';
import * as registry from '@app/api/middleware/ServiceRegistry';
import {UsernameOpIntents, UsernameOwners, Users} from '@app/api/Tables';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {compileUsernameDictionary} from '@app/api/user/username/UsernamePolicyService';
import {createUsernameOwnershipRuntime} from '@app/api/worker/tasks/UsernameRuntimeAdapters';
import {KVCacheProvider} from '@pkgs/cache/src/providers/KVCacheProvider';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, afterEach, beforeAll, beforeEach, expect, test, vi} from 'vitest';

const id = createUserID(1000000000000000002n);
const dictionary = compileUsernameDictionary(1, {uname_exact: [], uname_contains: [], uname_allow: []});
let configSerialReads: number;
let queries: number;
let backend: typeof Config.database.backend;

function count(query: PreparedQuery, options?: CassandraReadOptions): void {
	queries++;
	if (options?.consistency === 'serial' && query.cql.includes('instance_configuration')) configSerialReads++;
}

function runtime(grant: number) {
	const evalScript = vi.fn(async () => [grant, 1, 900]);
	const addJob = vi.fn(async () => {});
	registry.setInjectedWorkerService({addJob} as never);
	return {
		evalScript,
		service: createUsernameOwnershipRuntime({kv: {evalScript, isClustered: () => false}, worker: {addJob} as never}),
	};
}

beforeAll(() => {
	new LimitConfigService(
		new InstanceConfigRepository(),
		new KVCacheProvider({client: new MockKVProvider()}),
	).setAsGlobalInstance();
});
afterAll(() => resetGlobalLimitConfigServiceForTesting());
beforeEach(async () => {
	backend = Config.database.backend;
	Config.database.backend = 'cassandra';
	configSerialReads = 0;
	queries = 0;
	setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor({beforeQuery: count}));
	registry.setInjectedKVProvider(new MockKVProvider());
	registry.setInjectedGatewayService({dispatchPresence: vi.fn(async () => {})} as never);
	const migration = {
		state: 'selecting' as const,
		epoch: 1,
		preparing_at: '2026-10-09T00:00:00.000Z',
		started_at: '2026-10-09T00:01:00.000Z',
		forced_at: '2026-10-16T00:01:00.000Z',
	};
	const policy = {
		revision: 3,
		tiers: {'1': 'locked', '2': 'locked', '3': 'locked'},
		dictionary_gen: 1,
		dictionary_hash: dictionary.manifest.hash,
		next_dictionary_gen: 2,
		previous_dictionary_gen: 0,
		admission: {global_per_second: 100, paused: false},
		held_manifest: [],
	} as unknown as UsernamePolicyConfig;
	for (const method of ['readUsernameMigrationConfig', 'getUsernameMigrationConfig'] as const)
		vi.spyOn(InstanceConfigRepository.prototype, method).mockImplementation(async () => {
			if (method === 'readUsernameMigrationConfig') configSerialReads++;
			return migration;
		});
	for (const method of ['readUsernamePolicyConfig', 'getUsernamePolicyConfig'] as const)
		vi.spyOn(InstanceConfigRepository.prototype, method).mockImplementation(async () => {
			if (method === 'readUsernamePolicyConfig') configSerialReads++;
			return policy;
		});
	vi.spyOn(profileSubstringBlocklistCache, 'getUsernameDictionary').mockReturnValue(dictionary);
	vi.spyOn(profileSubstringBlocklistCache, 'loadUsernameDictionary').mockResolvedValue(dictionary);
	await upsertOne(
		Users.upsertAll({...EMPTY_USER_ROW, user_id: id, username: 'legacy', discriminator: 1234, version: 1}),
	);
	queries = 0;
	configSerialReads = 0;
});
afterEach(() => {
	Config.database.backend = backend;
	registry.setInjectedWorkerService(undefined);
	registry.setInjectedKVProvider(undefined);
	registry.setInjectedGatewayService(undefined);
	setCassandraQueryExecutorForTesting(null);
	vi.restoreAllMocks();
});

test('selecting claim through the real runtime is admitted by the Valkey budget alone', async () => {
	const {service, evalScript} = runtime(10);
	expect(await service.claimSelf(id, 'newname')).toEqual({ok: true, username: 'newname', noop: false});
	expect(evalScript).toHaveBeenCalledTimes(1);
	// Micup: one authoritative policy and migration read at acquire and again at commit.
	expect(configSerialReads).toBeLessThanOrEqual(4);
});

test('a claim rejected by admission sends no query to Cassandra', async () => {
	const {service} = runtime(0);
	expect(await service.claimSelf(id, 'newname')).toEqual({ok: false, code: 'RATE_LIMITED'});
	expect(queries).toBe(0);
	expect(configSerialReads).toBe(0);
});

test.each([
	{label: 'pauses', change: {admission: {global_per_second: 100, paused: true}}},
	{label: 'lowers the budget', change: {admission: {global_per_second: 1, paused: false}}},
])('a lease admitted under a cached policy cannot allocate after the authoritative policy $label', async ({change}) => {
	const cached = await new InstanceConfigRepository().getUsernamePolicyConfig();
	vi.spyOn(InstanceConfigRepository.prototype, 'readUsernamePolicyConfig').mockResolvedValue({
		...cached,
		...change,
		revision: cached.revision + 1,
	});
	const {service, evalScript} = runtime(10);
	expect(await service.claimSelf(id, 'newname')).toEqual({ok: false, code: 'RATE_LIMITED'});
	expect(evalScript).toHaveBeenCalledWith(
		expect.any(String),
		expect.any(String),
		1,
		'uadm:revision',
		cached.revision,
		100,
	);
	expect(await fetchMany(UsernameOwners.select().bind({}))).toEqual([]);
	expect(await fetchMany(UsernameOpIntents.select().bind({}))).toEqual([]);
});
