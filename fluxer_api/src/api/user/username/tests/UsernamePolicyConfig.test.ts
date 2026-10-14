// SPDX-License-Identifier: AGPL-3.0-or-later

import {createAuthHarness} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getConfig} from '@app/api/Config';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {getCachedAccountIdentity, setCachedAccountIdentity} from '@app/api/instance/AccountIdentityModeCache';
import {InstanceConfigCache} from '@app/api/instance/InstanceConfigCache';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {InstanceConfigWriteRaceExecutor} from '@app/api/instance/tests/InstanceConfigWriteRaceExecutor';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {createBuilderWithoutAuth} from '@app/api/test/TestRequestBuilder';
import {UsernameOwnershipService} from '@app/api/user/username/UsernameOwnershipService';
import {compileUsernameDictionary, UsernamePolicyService} from '@app/api/user/username/UsernamePolicyService';
import {readUsernameMigrationStartEvidence} from '@app/api/worker/tasks/UsernameMigrationEvidence';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const legacy = {state: 'legacy', epoch: 0, started_at: null, forced_at: null};
const identity = {
	mode: 'email',
	tag_style: 'random',
	source: 'existing_instance',
	decided_at: '2026-10-09T00:00:00.000Z',
};
const selecting = {
	state: 'selecting',
	epoch: 3,
	preparing_at: '2026-10-08T23:59:00.000Z',
	started_at: '2026-10-09T00:00:00.000Z',
	forced_at: '2026-10-16T00:00:00.000Z',
};

describe('username configuration', () => {
	let executor: InstanceConfigWriteRaceExecutor;
	let repository: InstanceConfigRepository;
	const repositories: Array<InstanceConfigRepository> = [];
	const config = getConfig();
	let selfHosted: boolean;
	beforeEach(() => {
		selfHosted = config.instance.selfHosted;
		config.instance.selfHosted = true;
		executor = new InstanceConfigWriteRaceExecutor(new InMemoryCassandraQueryExecutor());
		setCassandraQueryExecutorForTesting(executor);
		repository = new InstanceConfigRepository();
		repositories.push(repository);
	});
	afterEach(async () => {
		config.instance.selfHosted = selfHosted;
		await Promise.all(repositories.splice(0).map((entry) => entry.shutdown()));
		setCachedAccountIdentity(null);
	});
	it('interprets an absent migration as legacy and refuses malformed authoritative data', async () => {
		await repository.setConfig('account_identity_config', JSON.stringify(identity));
		expect(await repository.readUsernameMigrationConfig()).toEqual(legacy);
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, username_migration: {state: 'selecting'}}),
		);
		await expect(repository.readUsernameMigrationConfig()).rejects.toThrow();
	});
	it('renews the guild declaration during the current selecting epoch without changing migration dates', async () => {
		await repository.setConfig('account_identity_config', JSON.stringify({...identity, username_migration: selecting}));
		const value = {
			epoch: 3,
			admin_id: '43',
			max_guild_members: 100,
			max_guild_online: 10,
			source: 'new activity report',
			observed_at: new Date().toISOString(),
		};
		await repository.setUsernameMigrationGuildCapacity(value);
		expect(await repository.readUsernameMigrationGuildCapacity()).toEqual(value);
		expect(await repository.readUsernameMigrationConfig()).toEqual(selecting);
		await expect(repository.setUsernameMigrationGuildCapacity({...value, epoch: 2})).rejects.toThrow();
		await expect(
			repository.setUsernameMigrationGuildCapacity({
				...value,
				observed_at: new Date(Date.now() - 3_600_000).toISOString(),
			}),
		).rejects.toThrow();
	});
	it('preserves migration dates in the identity cache and keeps migration setup locked', async () => {
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, source: 'migration', tag_style: 'none', username_migration: selecting}),
		);
		expect((await repository.getAccountIdentity()).usernameMigration).toEqual(selecting);
		expect(getCachedAccountIdentity().usernameMigration).toEqual(selecting);
		expect(await repository.isAccountIdentityLocked()).toBe(true);
	});
	it.each([true, false])(
		'preserves migration in the resolved identity and hot cache when selfHosted=%s',
		async (hosted) => {
			config.instance.selfHosted = hosted;
			await repository.setConfig(
				'account_identity_config',
				JSON.stringify({...identity, source: 'migration', tag_style: 'none', username_migration: selecting}),
			);
			const expected = {mode: 'email', tagStyle: hosted ? 'none' : 'random', usernameMigration: selecting};
			expect(await repository.getAccountIdentity()).toEqual(expected);
			expect(getCachedAccountIdentity()).toEqual(expected);
			expect(await repository.readUsernameMigrationConfig()).toEqual(selecting);
			expect(await repository.isAccountIdentityLocked()).toBe(true);
		},
	);
	it('keeps hosted sign-in defaults while carrying migration through a config cache refresh', async () => {
		config.instance.selfHosted = false;
		const provider = new MockKVProvider();
		const cached = new InstanceConfigRepository(provider);
		const writer = new InstanceConfigRepository(provider);
		repositories.push(cached, writer);
		await cached.getAllConfigs();
		await writer.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, mode: 'username', source: 'migration', username_migration: selecting}),
		);
		await vi.waitFor(() => {
			expect(getCachedAccountIdentity()).toEqual({mode: 'email', tagStyle: 'random', usernameMigration: selecting});
		});
		expect(await cached.getAccountIdentity()).toEqual({
			mode: 'email',
			tagStyle: 'random',
			usernameMigration: selecting,
		});
	});
	it.each([true, false])(
		'fails closed on malformed identity in the resolver and cache when selfHosted=%s',
		async (hosted) => {
			config.instance.selfHosted = hosted;
			await repository.setConfig(
				'account_identity_config',
				JSON.stringify({...identity, source: 'migration', username_migration: {state: 'selecting'}}),
			);
			await expect(repository.getAccountIdentity()).rejects.toThrow();
			expect(() => getCachedAccountIdentity()).toThrow();
		},
	);
	it('does not let setup overwrite a persisted migration', async () => {
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, source: 'migration', username_migration: selecting}),
		);
		await expect(repository.setAccountIdentityMode('email', 'setup')).rejects.toThrow();
		expect(await repository.readUsernameMigrationConfig()).toEqual(selecting);
	});
	it('reserves unique generations without advancing the published policy revision', async () => {
		executor.watch('username_policy');
		executor.pauseWritesUntil(2);
		const [first, second] = await Promise.all([
			repository.reserveUsernameDictionaryGeneration(),
			repository.reserveUsernameDictionaryGeneration(),
		]);
		expect(new Set([first.generation, second.generation]).size).toBe(2);
		expect(first.baseRevision).toBe(0);
		expect(second.baseRevision).toBe(0);
		expect((await repository.readUsernamePolicyConfig()).dictionary_gen).toBe(0);
	});
	it('publishes exactly one concurrent dictionary and rejects a stale policy base', async () => {
		const first = await repository.reserveUsernameDictionaryGeneration();
		const second = await repository.reserveUsernameDictionaryGeneration();
		executor.watch('username_policy');
		executor.pauseWritesUntil(2);
		const published = await Promise.all([
			repository.publishUsernameDictionaryGeneration(first, 'a'.repeat(64)),
			repository.publishUsernameDictionaryGeneration(second, 'b'.repeat(64)),
		]);
		expect(published.filter(Boolean)).toHaveLength(1);
		const stale = await repository.reserveUsernameDictionaryGeneration();
		await repository.setUsernamePolicyConfig({tiers: {'1': 'public', '2': 'locked', '3': 'locked'}});
		expect(await repository.publishUsernameDictionaryGeneration(stale, 'c'.repeat(64))).toBe(false);
	});
	it('retains reservation metadata and protects the actual previous published generation across cleanup fences', async () => {
		const first = await repository.reserveUsernameDictionaryGeneration();
		expect(await repository.readUsernameDictionaryGenerationMetadata(first.generation)).toEqual({
			created_at: first.createdAt,
		});
		expect(await repository.publishUsernameDictionaryGeneration(first, 'a'.repeat(64))).toBe(true);
		await repository.reserveUsernameDictionaryGeneration();
		const third = await repository.reserveUsernameDictionaryGeneration();
		expect(await repository.publishUsernameDictionaryGeneration(third, 'b'.repeat(64))).toBe(true);
		const policy = await repository.readUsernamePolicyConfig();
		expect(policy.previous_dictionary_gen).toBe(first.generation);
		const stale = await repository.reserveUsernameDictionaryGeneration();
		expect(await repository.fenceUsernameDictionaryGenerationCleanup(policy)).toBe(true);
		expect(await repository.publishUsernameDictionaryGeneration(stale, 'c'.repeat(64))).toBe(false);
		expect(await repository.fenceUsernameDictionaryGenerationCleanup(policy)).toBe(false);
		expect(await repository.readUsernameDictionaryGenerationMetadata(first.generation)).toEqual({
			created_at: first.createdAt,
		});
		const initial = {day: '2026-10-09', cursor: 1};
		expect(await repository.compareAndSetUsernameDictionaryCleanupState(null, initial)).toBe(true);
		expect(await repository.readUsernameDictionaryCleanupState()).toEqual(initial);
		expect(await repository.compareAndSetUsernameDictionaryCleanupState(null, initial)).toBe(false);
	});
	it('keeps concurrent admission and tier changes and increments revisions', async () => {
		executor.watch('username_policy');
		executor.pauseWritesUntil(2);
		await Promise.all([
			repository.setUsernamePolicyConfig({admission: {global_per_second: 10, paused: false}}),
			repository.setUsernamePolicyConfig({tiers: {'1': 'public', '2': 'for_sale', '3': 'locked'}}),
		]);
		expect(await repository.readUsernamePolicyConfig()).toMatchObject({
			revision: 2,
			admission: {global_per_second: 10, paused: false},
			tiers: {'1': 'public', '2': 'for_sale', '3': 'locked'},
		});
	});
	it('reads allocation policy directly even with a stale cache', async () => {
		const cached = new InstanceConfigRepository(new MockKVProvider());
		repositories.push(cached);
		await cached.initialize();
		await repository.setUsernamePolicyConfig({admission: {global_per_second: 8, paused: false}});
		expect((await cached.getUsernamePolicyConfig()).admission.paused).toBe(true);
		expect((await cached.readUsernamePolicyConfig()).admission.paused).toBe(false);
	});
	it('accepts only same-epoch scan progress from its current cursor', async () => {
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({
				...identity,
				source: 'migration',
				username_migration: {...legacy, state: 'preparing', epoch: 2, preparing_at: '2026-10-08T23:59:00.000Z'},
			}),
		);
		const initial = await repository.initializeUsernameMigrationScan(2);
		expect(initial).toEqual({epoch: 2, cursor: null, scanned: 0, found: 0, done_at: null});
		const next = {...initial, cursor: 'page2', scanned: 500};
		expect(await repository.compareAndSetUsernameMigrationScan(initial, next)).toBe(true);
		expect(await repository.compareAndSetUsernameMigrationScan(initial, {...next, scanned: 1000})).toBe(false);
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({
				...identity,
				source: 'migration',
				username_migration: {...legacy, state: 'preparing', epoch: 3, preparing_at: '2026-10-08T23:59:00.000Z'},
			}),
		);
		expect(await repository.compareAndSetUsernameMigrationScan(next, {...next, scanned: 1000})).toBe(false);
		await repository.initializeUsernameMigrationScan(3);
		await expect(repository.initializeUsernameMigrationScan(2)).rejects.toThrow();
	});
	it('preserves repair cursor fields without interpreting the worker contract', async () => {
		const state = {oldest_day: '2026-10-07', bucket: 12, continuation: {position: 'row', round: 4}};
		expect(await repository.readUsernameRepairState()).toBeNull();
		expect(await repository.compareAndSetUsernameRepairState(null, state)).toBe(true);
		expect(await repository.readUsernameRepairState()).toEqual(state);
		expect(await repository.compareAndSetUsernameRepairState(null, {oldest_day: '2026-10-08'})).toBe(false);
	});
	it('persists preparation once and initializes a scan without changing email identity', async () => {
		await repository.setConfig('account_identity_config', JSON.stringify(identity));
		await expect(repository.prepareUsernameMigration({processesReady: false})).rejects.toThrow();
		const prepared = await repository.prepareUsernameMigration({processesReady: true});
		expect(prepared).toMatchObject({state: 'preparing', epoch: 1, started_at: null, forced_at: null});
		expect(Number.isFinite(Date.parse(prepared.preparing_at!))).toBe(true);
		expect(await repository.prepareUsernameMigration({processesReady: true})).toEqual(prepared);
		expect(await repository.readAccountIdentityConfig()).toMatchObject({
			mode: 'email',
			tag_style: 'random',
			source: 'migration',
		});
		expect(await repository.readUsernameMigrationScan()).toEqual({
			epoch: 1,
			cursor: null,
			scanned: 0,
			found: 0,
			done_at: null,
		});
	});
	it('rejects scan writes before the durable sixty-second barrier and invalid page counts', async () => {
		await repository.setConfig('account_identity_config', JSON.stringify(identity));
		const prepared = await repository.prepareUsernameMigration({processesReady: true});
		const initial = (await repository.readUsernameMigrationScan())!;
		expect(await repository.compareAndSetUsernameMigrationScan(initial, {...initial, scanned: 500})).toBe(false);
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse(prepared.preparing_at!) + 60_000);
		try {
			await expect(
				repository.compareAndSetUsernameMigrationScan(initial, {...initial, scanned: 1, found: 2}),
			).rejects.toThrow();
			expect(await repository.compareAndSetUsernameMigrationScan(initial, {...initial, scanned: 500})).toBe(true);
		} finally {
			vi.restoreAllMocks();
		}
	});
	it('requires durable scan, dictionary and server proofs before irreversible selecting', async () => {
		await repository.setConfig('account_identity_config', JSON.stringify(identity));
		const prepared = await repository.prepareUsernameMigration({processesReady: true});
		const proof = {
			policyRevision: 0,
			dictionaryGen: 1,
			dictionaryHash: 'a'.repeat(64),
			holdsReady: true,
			reserveVersion: 0,
			capacityReady: true,
			mobilePublished: true,
		};
		await expect(repository.startUsernameMigration(1, proof)).rejects.toThrow();
		vi.spyOn(Date, 'now').mockReturnValue(Date.parse(prepared.preparing_at!) + 60_000);
		try {
			const initial = (await repository.readUsernameMigrationScan())!;
			await repository.compareAndSetUsernameMigrationScan(initial, {
				...initial,
				scanned: 500,
				done_at: new Date(Date.now()).toISOString(),
			});
			await expect(repository.startUsernameMigration(1, proof)).rejects.toThrow();
			const reserved = await repository.reserveUsernameDictionaryGeneration();
			await repository.publishUsernameDictionaryGeneration(reserved, proof.dictionaryHash);
			await repository.setUsernamePolicyConfig({admission: {global_per_second: 10, paused: false}});
			await repository.setUsernamePolicyConfig({held_manifest: []});
			await repository.setUsernameMigrationGuildCapacity({
				epoch: 1,
				admin_id: '43',
				max_guild_members: 100,
				max_guild_online: 10,
				source: 'activity report',
				observed_at: new Date(Date.now()).toISOString(),
			});
			await expect(repository.startUsernameMigration(1, proof)).rejects.toThrow();
			proof.policyRevision = (await repository.readUsernamePolicyConfig()).revision;
			for (const missing of ['holdsReady', 'capacityReady', 'mobilePublished'] as const) {
				await expect(repository.startUsernameMigration(1, {...proof, [missing]: false})).rejects.toThrow();
			}
			await expect(repository.startUsernameMigration(1, {...proof, dictionaryHash: 'b'.repeat(64)})).rejects.toThrow();
			const selected = await repository.startUsernameMigration(1, proof);
			expect(selected.preparing_at).toBe(prepared.preparing_at);
			expect(Date.parse(selected.forced_at!) - Date.parse(selected.started_at!)).toBe(7 * 86400000);
			expect(await repository.startUsernameMigration(1, proof)).toEqual(selected);
			await expect(repository.rollbackUsernameMigration(1)).rejects.toThrow();
			await expect(repository.prepareUsernameMigration({processesReady: true})).rejects.toThrow();
			expect(await repository.readAccountIdentityConfig()).toMatchObject({
				mode: 'email',
				tag_style: 'none',
				source: 'migration',
			});
		} finally {
			vi.restoreAllMocks();
		}
	});
	it('preserves epochs on rollback and rejects stale scan workers after the next preparation', async () => {
		await repository.setConfig('account_identity_config', JSON.stringify(identity));
		await repository.prepareUsernameMigration({processesReady: true});
		const initial = (await repository.readUsernameMigrationScan())!;
		await expect(repository.rollbackUsernameMigration(2)).rejects.toThrow();
		expect(await repository.rollbackUsernameMigration(1)).toMatchObject({
			state: 'legacy',
			epoch: 1,
			preparing_at: null,
		});
		await repository.prepareUsernameMigration({processesReady: true});
		expect((await repository.readUsernameMigrationScan())?.epoch).toBe(2);
		expect(await repository.compareAndSetUsernameMigrationScan(initial, {...initial, scanned: 500})).toBe(false);
	});
	it('fails closed on active migration records without a preparation time', async () => {
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, source: 'migration', username_migration: {...legacy, state: 'preparing', epoch: 1}}),
		);
		await expect(repository.readUsernameMigrationConfig()).rejects.toThrow();
	});
	it('rejects a future stored scan completion', async () => {
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({
				...identity,
				source: 'migration',
				username_migration: {...legacy, state: 'preparing', epoch: 1, preparing_at: '2026-10-08T23:59:00.000Z'},
			}),
		);
		const reservation = await repository.reserveUsernameDictionaryGeneration();
		await repository.publishUsernameDictionaryGeneration(reservation, 'a'.repeat(64));
		await repository.setUsernamePolicyConfig({admission: {global_per_second: 10, paused: false}});
		await repository.setConfig(
			'username_migration_scan',
			JSON.stringify({epoch: 1, cursor: null, scanned: 500, found: 0, done_at: '2099-01-01T00:00:00.000Z'}),
		);
		await expect(
			repository.startUsernameMigration(1, {
				policyRevision: (await repository.readUsernamePolicyConfig()).revision,
				dictionaryGen: 1,
				dictionaryHash: 'a'.repeat(64),
				holdsReady: true,
				reserveVersion: 0,
				capacityReady: true,
				mobilePublished: true,
			}),
		).rejects.toThrow();
	});
	it('keeps cleanup checkpoints private without broadcasting config refresh', async () => {
		const provider = new MockKVProvider();
		const stored = new InstanceConfigRepository(provider);
		repositories.push(stored);
		const publish = vi.spyOn(provider, 'publish');
		expect(await stored.compareAndSetUsernameDictionaryCleanupState(null, {day: '2026-10-09', cursor: 1})).toBe(true);
		expect(publish).not.toHaveBeenCalled();
		expect((await stored.getAllConfigs()).has('username_dictionary_cleanup')).toBe(false);
		const reserved = await stored.reserveUsernameDictionaryGeneration();
		expect((await stored.getAllConfigs()).has(`username_dictionary_generation:${reserved.generation}`)).toBe(false);
	});
	it('rejects corrupt previous dictionary pointers', async () => {
		const reservation = await repository.reserveUsernameDictionaryGeneration();
		await repository.publishUsernameDictionaryGeneration(reservation, 'a'.repeat(64));
		const policy = await repository.readUsernamePolicyConfig();
		for (const previous of [policy.dictionary_gen, policy.next_dictionary_gen]) {
			await repository.setConfig('username_policy', JSON.stringify({...policy, previous_dictionary_gen: previous}));
			await expect(repository.readUsernamePolicyConfig()).rejects.toThrow();
		}
	});
	it('confirms a committed pointer after a lost response and handles its retry idempotently', async () => {
		const base = new InMemoryCassandraQueryExecutor();
		let loseResponse = false;
		setCassandraQueryExecutorForTesting({
			async executeQuery<T = Record<string, unknown>>(query: PreparedQuery): Promise<Array<T>> {
				const result = await base.executeQuery<T>(query);
				if (loseResponse && query.cql.includes('IF value')) {
					loseResponse = false;
					throw new Error('Lost Cassandra response');
				}
				return result;
			},
			executeBatch: (queries, atomic) => base.executeBatch(queries, atomic),
		});
		const reservation = await repository.reserveUsernameDictionaryGeneration();
		loseResponse = true;
		expect(await repository.publishUsernameDictionaryGeneration(reservation, 'd'.repeat(64))).toBe(true);
		expect(loseResponse).toBe(false);
		expect(await repository.publishUsernameDictionaryGeneration(reservation, 'd'.repeat(64))).toBe(true);
	});
	it('rejects corrupt identity instead of retaining a selecting cache', async () => {
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, source: 'migration', username_migration: selecting}),
		);
		await repository.getAccountIdentity();
		await repository.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, source: 'migration', username_migration: {...selecting, epoch: -1}}),
		);
		await expect(repository.getAccountIdentity()).rejects.toThrow();
		expect(() => getCachedAccountIdentity()).toThrow();
		await expect(repository.readUsernameMigrationConfig()).rejects.toThrow();
	});
	it('discards a stale selecting snapshot after a malformed refresh', async () => {
		const provider = new MockKVProvider();
		const reader = new InstanceConfigRepository(provider);
		const writer = new InstanceConfigRepository(provider);
		repositories.push(reader, writer);
		await writer.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, source: 'migration', username_migration: selecting}),
		);
		await reader.initialize();
		expect((await reader.getAccountIdentity()).usernameMigration).toEqual(selecting);
		await writer.setConfig(
			'account_identity_config',
			JSON.stringify({...identity, username_migration: {state: 'preparing'}}),
		);
		await vi.waitFor(() => expect(() => getCachedAccountIdentity()).toThrow());
		await expect(reader.getAccountIdentity()).rejects.toThrow();
	});
	it('rejects unsafe generation counters and corrupt policy without allocating', async () => {
		const policy = await repository.readUsernamePolicyConfig();
		await repository.setConfig(
			'username_policy',
			JSON.stringify({...policy, next_dictionary_gen: Number.MAX_SAFE_INTEGER}),
		);
		await expect(repository.reserveUsernameDictionaryGeneration()).rejects.toThrow();
		await repository.setConfig('username_policy', '{invalid');
		await expect(repository.readUsernamePolicyConfig()).rejects.toThrow();
	});
	it('does not give an uncertain losing reservation the winning publishers generation', async () => {
		executor.watch('username_policy');
		executor.pauseWritesUntil(2);
		setCassandraQueryExecutorForTesting({
			async executeQuery<T = Record<string, unknown>>(query: PreparedQuery): Promise<Array<T>> {
				const result = await executor.executeQuery<T>(query);
				if ((result[0] as {'[applied]'?: boolean})?.['[applied]'] === false) throw new Error('Lost unapplied response');
				return result;
			},
			executeBatch: (queries, atomic) => executor.executeBatch(queries, atomic),
		});
		const results = await Promise.allSettled([
			repository.reserveUsernameDictionaryGeneration(),
			repository.reserveUsernameDictionaryGeneration(),
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
	});
	it.each([true, false])(
		'carries migration dates and tiers losslessly through discovery when selfHosted=%s',
		async (hosted) => {
			const harness = await createAuthHarness();
			try {
				config.instance.selfHosted = hosted;
				const stored = getInstanceConfigRepository();
				await stored.setConfig(
					'account_identity_config',
					JSON.stringify({...identity, source: 'migration', tag_style: 'none', username_migration: selecting}),
				);
				await stored.setUsernamePolicyConfig({tiers: {'1': 'locked', '2': 'for_sale', '3': 'public'}});
				const response = await createBuilderWithoutAuth<{username_migration: unknown; username_tiers: unknown}>(harness)
					.get('/.well-known/fluxer')
					.execute();
				expect(response.username_migration).toEqual(selecting);
				expect(response.username_tiers).toEqual({'1': 'locked', '2': 'for_sale', '3': 'public'});
				expect(getCachedAccountIdentity().usernameMigration).toEqual(selecting);
			} finally {
				await harness.shutdown();
			}
		},
	);
	describe('reservation fence', () => {
		const admin = {adminId: createUserID(43n), reason: 'manifest', note: 'manifest'};
		let backend: 'cassandra' | 'postgres';
		beforeEach(() => {
			backend = config.database.backend;
			config.database.backend = 'cassandra';
		});
		afterEach(() => {
			config.database.backend = backend;
			vi.restoreAllMocks();
		});
		async function readyToStart() {
			await repository.setConfig('account_identity_config', JSON.stringify(identity));
			const prepared = await repository.prepareUsernameMigration({processesReady: true});
			vi.spyOn(Date, 'now').mockReturnValue(Date.parse(prepared.preparing_at!) + 60_000);
			const scan = (await repository.readUsernameMigrationScan())!;
			await repository.compareAndSetUsernameMigrationScan(scan, {
				...scan,
				scanned: 500,
				done_at: new Date(Date.now()).toISOString(),
			});
			const dictionary = compileUsernameDictionary(1, {uname_exact: [], uname_contains: [], uname_allow: []});
			const reserved = await repository.reserveUsernameDictionaryGeneration();
			await repository.publishUsernameDictionaryGeneration(reserved, dictionary.manifest.hash);
			await repository.setUsernamePolicyConfig({
				admission: {global_per_second: 10, paused: false},
				held_manifest: ['destek'],
			});
			const ownership = new UsernameOwnershipService({
				policy: new UsernamePolicyService(repository, {
					getUsernameDictionary: () => dictionary,
					loadUsernameDictionary: async () => dictionary,
				}),
				clock: async () => ({offsetMs: 0, uncertaintyMs: 0}),
				propagate: async () => {},
				neutralDiscriminator: async () => 1234,
			});
			const inspect = async () => {
				const policyRevision = (await repository.readUsernamePolicyConfig()).revision;
				const {holds, reserveVersion} = await readUsernameMigrationStartEvidence(repository);
				return {
					policyRevision,
					dictionaryGen: 1,
					dictionaryHash: dictionary.manifest.hash,
					holdsReady: holds.ready,
					reserveVersion,
					capacityReady: true,
					mobilePublished: true,
				};
			};
			expect(await ownership.adminHold('destek', admin)).toMatchObject({ok: true});
			return {ownership, inspect};
		}
		function pauseOnce<T extends object, K extends keyof T>(target: T, method: K) {
			const original = (target[method] as (...args: Array<unknown>) => Promise<unknown>).bind(target);
			let resume!: () => void;
			let reached!: () => void;
			const paused = new Promise<void>((resolve) => {
				resume = resolve;
			});
			const arrived = new Promise<void>((resolve) => {
				reached = resolve;
			});
			vi.spyOn(target, method as never).mockImplementationOnce((async (...args: Array<unknown>) => {
				const result = await original(...args);
				reached();
				await paused;
				return result;
			}) as never);
			return {arrived, resume};
		}
		it('a reservation released after the start inspection rejects the start', async () => {
			const {ownership, inspect} = await readyToStart();
			const stale = await inspect();
			expect(stale.holdsReady).toBe(true);
			await ownership.adminUnhold('destek', admin);
			await expect(repository.startUsernameMigration(1, stale)).rejects.toThrow();
			expect((await inspect()).holdsReady).toBe(false);
			expect(await ownership.adminHold('destek', admin)).toMatchObject({ok: true});
			expect(await repository.startUsernameMigration(1, await inspect())).toMatchObject({state: 'selecting'});
		});
		it('a release between the start policy read and the start CAS rejects the start', async () => {
			const {ownership, inspect} = await readyToStart();
			const proof = await inspect();
			const gate = pauseOnce(repository, 'readUsernamePolicyConfig');
			const start = repository.startUsernameMigration(1, proof);
			await gate.arrived;
			await ownership.adminUnhold('destek', admin);
			gate.resume();
			await expect(start).rejects.toThrow();
			expect((await repository.readUsernameMigrationConfig()).state).toBe('preparing');
			expect((await ownership.repository.readClaim('destek'))?.state).toBe('released');
		});
		it('an inspection during an unfinished release yields no start proof', async () => {
			const {ownership, inspect} = await readyToStart();
			const gate = pauseOnce(ownership.repository, 'readClaim');
			const unhold = ownership.adminUnhold('destek', admin);
			await gate.arrived;
			const proof = await inspect();
			expect(proof.holdsReady).toBe(false);
			gate.resume();
			await unhold;
			await expect(repository.startUsernameMigration(1, proof)).rejects.toThrow();
			expect((await repository.readUsernameMigrationConfig()).state).toBe('preparing');
		});
		it('a release that crashed inside the fence keeps the start closed until it is run again', async () => {
			const {ownership, inspect} = await readyToStart();
			const before = await inspect();
			vi.spyOn(ownership.repository, 'casClaim').mockRejectedValueOnce(new Error('process crashed'));
			await expect(ownership.adminUnhold('destek', admin)).rejects.toThrow();
			expect((await ownership.repository.readClaim('destek'))?.state).toBe('held');
			expect((await inspect()).holdsReady).toBe(false);
			await expect(repository.startUsernameMigration(1, before)).rejects.toThrow();
			await ownership.adminUnhold('destek', admin);
			expect((await inspect()).holdsReady).toBe(false);
			expect(await ownership.adminHold('destek', admin)).toMatchObject({ok: true});
			expect(await repository.startUsernameMigration(1, await inspect())).toMatchObject({state: 'selecting'});
		});
		it('a release whose fence was taken over by a later release does not apply', async () => {
			const {ownership, inspect} = await readyToStart();
			expect(await ownership.adminHold('yardim', admin)).toMatchObject({ok: true});
			const gate = pauseOnce(repository, 'openUsernameReserveMutation');
			const first = ownership.adminUnhold('destek', admin);
			await gate.arrived;
			await ownership.adminUnhold('yardim', admin);
			gate.resume();
			await expect(first).rejects.toThrow();
			expect((await ownership.repository.readClaim('destek'))?.state).toBe('held');
			expect(await repository.startUsernameMigration(1, await inspect())).toMatchObject({state: 'selecting'});
		});
	});
});

describe('bounded instance config freshness', () => {
	let cache: InstanceConfigCache;
	let now: number;
	beforeEach(() => {
		now = 100000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
	});
	afterEach(async () => {
		await cache?.shutdown();
		vi.restoreAllMocks();
	});
	it.each([null, new MockKVProvider({subscriptionOptions: {shouldFailConnect: true}})])(
		'preserves direct-database fallback when the provider is absent or unavailable',
		async (provider) => {
			const load = vi.fn(async () => new Map([['username_policy', 'cached']]));
			cache = new InstanceConfigCache({provider, channel: 'config', load, onRefresh: () => {}});
			expect(await cache.getSnapshot()).toBeNull();
			expect(await cache.getSnapshot()).toBeNull();
			expect(load).not.toHaveBeenCalled();
		},
	);
	it('refreshes a missed notification after five seconds with one load for concurrent readers', async () => {
		let stored = 'old';
		const load = vi.fn(async () => new Map([['username_policy', stored]]));
		cache = new InstanceConfigCache({provider: new MockKVProvider(), channel: 'config', load, onRefresh: () => {}});
		expect((await cache.getSnapshot())?.get('username_policy')).toBe('old');
		stored = 'new';
		now += 4999;
		await Promise.all(Array.from({length: 32}, () => cache.getSnapshot()));
		expect(load).toHaveBeenCalledTimes(1);
		now += 1;
		const snapshots = await Promise.all(Array.from({length: 32}, () => cache.getSnapshot()));
		expect(snapshots.every((snapshot) => snapshot?.get('username_policy') === 'new')).toBe(true);
		expect(load).toHaveBeenCalledTimes(2);
	});
	it('remembers a failed notification and recovers by one bounded request-driven retry', async () => {
		const provider = new MockKVProvider();
		let failed = false;
		let stored = 'selecting';
		const load = vi.fn(async () => {
			if (failed) throw new Error('Transient config load failure');
			return new Map([['account_identity_config', stored]]);
		});
		cache = new InstanceConfigCache({provider, channel: 'config', load, onRefresh: () => {}});
		expect((await cache.getSnapshot())?.get('account_identity_config')).toBe('selecting');
		failed = true;
		await provider.publish('config', '{}');
		await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
		await expect(cache.getSnapshot()).rejects.toThrow('Transient config load failure');
		failed = false;
		stored = 'preparing';
		now += 4999;
		const rejected = await Promise.allSettled(Array.from({length: 32}, () => cache.getSnapshot()));
		expect(rejected.every((result) => result.status === 'rejected')).toBe(true);
		expect(load).toHaveBeenCalledTimes(2);
		now += 1;
		const snapshots = await Promise.all(Array.from({length: 32}, () => cache.getSnapshot()));
		expect(snapshots.every((snapshot) => snapshot?.get('account_identity_config') === 'preparing')).toBe(true);
		expect(load).toHaveBeenCalledTimes(3);
		await cache.getSnapshot();
		expect(load).toHaveBeenCalledTimes(3);
	});
	it('rejects a delayed stale load and recovers without extending its freshness or retrying every request', async () => {
		let stored = 'old';
		let delayed = false;
		const load = vi.fn(async () => {
			const snapshot = new Map([['username_policy', stored]]);
			if (delayed) {
				now += 7000;
				stored = 'new';
				delayed = false;
			}
			return snapshot;
		});
		const onRefresh = vi.fn();
		cache = new InstanceConfigCache({provider: new MockKVProvider(), channel: 'config', load, onRefresh});
		expect((await cache.getSnapshot())?.get('username_policy')).toBe('old');
		delayed = true;
		now += 5000;
		const failed = await Promise.allSettled(Array.from({length: 32}, () => cache.getSnapshot()));
		expect(failed.every((result) => result.status === 'rejected')).toBe(true);
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(load).toHaveBeenCalledTimes(2);
		now += 4999;
		await expect(cache.getSnapshot()).rejects.toThrow('freshness budget');
		expect(load).toHaveBeenCalledTimes(2);
		now += 1;
		const snapshots = await Promise.all(Array.from({length: 32}, () => cache.getSnapshot()));
		expect(snapshots.every((snapshot) => snapshot?.get('username_policy') === 'new')).toBe(true);
		expect(load).toHaveBeenCalledTimes(3);
		expect(onRefresh).toHaveBeenCalledTimes(2);
	});
	it('counts a successful delayed load against the five-second freshness window', async () => {
		let stored = 'old';
		let first = true;
		const load = vi.fn(async () => {
			const snapshot = new Map([['username_policy', stored]]);
			if (first) {
				now += 4000;
				first = false;
			}
			return snapshot;
		});
		cache = new InstanceConfigCache({provider: new MockKVProvider(), channel: 'config', load, onRefresh: () => {}});
		expect((await cache.getSnapshot())?.get('username_policy')).toBe('old');
		stored = 'new';
		now += 999;
		expect((await cache.getSnapshot())?.get('username_policy')).toBe('old');
		expect(load).toHaveBeenCalledTimes(1);
		now += 1;
		expect((await cache.getSnapshot())?.get('username_policy')).toBe('new');
		expect(load).toHaveBeenCalledTimes(2);
	});
});
