// SPDX-License-Identifier: AGPL-3.0-or-later
import {beforeEach, describe, expect, it, vi} from 'vitest';

const storage = vi.hoisted(() => {
	vi.resetModules();
	return {fetchMany: vi.fn(), loadAll: vi.fn()};
});
vi.mock('@app/api/Config', () => ({Config: {nodeEnv: 'test'}}));
vi.mock('@app/api/instance/InstanceConfigRepository', () => ({InstanceConfigRepository: class {}}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({getInstanceConfigRepository: vi.fn()}));
vi.mock('@app/api/admin/AdminRepository', () => ({
	AdminRepository: class {
		loadAllBannedProfileSubstrings = storage.loadAll;
	},
}));
vi.mock('@app/api/database/CassandraQueryExecution', () => ({fetchMany: storage.fetchMany}));
vi.mock('@app/api/Logger', () => ({Logger: {debug: vi.fn(), error: vi.fn(), warn: vi.fn()}}));

import {
	loadUsernameDictionaryGeneration,
	ProfileSubstringBlocklistCache,
} from '@app/api/middleware/ProfileSubstringBlocklistCache';
import {computeUsernameDictionaryManifest} from '../UsernamePolicyService';

const entries = {uname_exact: ['admin'], uname_contains: ['allah'], uname_allow: ['allahverdi']};
const manifest = computeUsernameDictionaryManifest(entries);
beforeEach(() => {
	storage.fetchMany.mockReset();
	storage.loadAll.mockReset();
});
describe('username dictionary cache isolation', () => {
	it('refresh reads only five legacy profile partitions and never scans generation rows', async () => {
		storage.loadAll.mockResolvedValue([]);
		storage.fetchMany.mockResolvedValue([]);
		await new ProfileSubstringBlocklistCache().refresh();
		expect(storage.loadAll).not.toHaveBeenCalled();
		expect(storage.fetchMany).toHaveBeenCalledTimes(5);
		expect(storage.fetchMany.mock.calls.map(([query]) => query.params.scope).sort()).toEqual([
			'bio',
			'global_name',
			'nickname',
			'pronouns',
			'username',
		]);
		for (const [query] of storage.fetchMany.mock.calls) expect(query.cql).toContain('WHERE scope = :scope');
	});
	it('provides generation loading separately from profile matching', () =>
		expect(loadUsernameDictionaryGeneration).toBeTypeOf('function'));
	it('reads only exact generation partitions and deduplicates concurrent loads', async () => {
		storage.fetchMany.mockImplementation(async (query: {params: {scope: string}}) => {
			if (query.params.scope === 'username') return [{scope: 'username', substring: 'legacybad'}];
			if (!query.params.scope.startsWith('uname_')) return [];
			return entries[query.params.scope.split(':')[0] as keyof typeof entries].map((substring) => ({substring}));
		});
		const cache = new ProfileSubstringBlocklistCache();
		const [a, b] = await Promise.all([
			cache.loadUsernameDictionary(3, manifest.hash),
			cache.loadUsernameDictionary(3, manifest.hash),
		]);
		expect(a).toBe(b);
		expect(storage.fetchMany).toHaveBeenCalledTimes(3);
		const queries = storage.fetchMany.mock.calls.map(([query]) => query);
		expect(queries.map((query) => query.params.scope).sort()).toEqual([
			'uname_allow:g3',
			'uname_contains:g3',
			'uname_exact:g3',
		]);
		for (const query of queries) expect(query.cql).toContain('WHERE scope = :scope');
		expect(cache.getUsernameDictionary(3, manifest.hash)).toBe(a);
		expect(cache.getUsernameDictionary(3, '0'.repeat(64))).toBeNull();
	});
	it('rejects incomplete or mismatched generation and does not retain failed in-flight loads', async () => {
		storage.fetchMany.mockResolvedValue([]);
		const cache = new ProfileSubstringBlocklistCache();
		await expect(cache.loadUsernameDictionary(3, manifest.hash)).rejects.toThrow();
		expect(cache.getUsernameDictionary(3, manifest.hash)).toBeNull();
		storage.fetchMany.mockImplementation(async (query: {params: {scope: string}}) =>
			entries[query.params.scope.split(':')[0] as keyof typeof entries].map((substring) => ({substring})),
		);
		expect((await cache.loadUsernameDictionary(3, manifest.hash)).contains('allah')).toBe(true);
	});
	it('loads a newer authoritative pointer after a lost notification while existing snapshots remain immutable', async () => {
		const newer = {...entries, uname_contains: ['newblocked']};
		storage.fetchMany.mockImplementation(async (query: {params: {scope: string}}) => {
			const source = query.params.scope.endsWith(':g3') ? entries : newer;
			return source[query.params.scope.split(':')[0] as keyof typeof entries].map((substring) => ({substring}));
		});
		const cache = new ProfileSubstringBlocklistCache();
		const old = await cache.loadUsernameDictionary(3, manifest.hash);
		const current = await cache.loadUsernameDictionary(4, computeUsernameDictionaryManifest(newer).hash);
		expect(old.contains('allah')).toBe(true);
		expect(current.contains('allah')).toBe(false);
		expect(current.contains('newblocked')).toBe(true);
		expect(storage.loadAll).not.toHaveBeenCalled();
	});
	it('generation names do not enter legacy merged profile scopes; legacy profiles do not enter usernames', async () => {
		storage.loadAll.mockResolvedValue([
			{scope: 'username', substring: 'legacybad'},
			{scope: 'uname_contains:g3', substring: 'allah'},
		]);
		storage.fetchMany.mockImplementation(async (query: {params: {scope: string}}) => {
			if (query.params.scope === 'username') return [{scope: 'username', substring: 'legacybad'}];
			if (!query.params.scope.startsWith('uname_')) return [];
			return entries[query.params.scope.split(':')[0] as keyof typeof entries].map((substring) => ({substring}));
		});
		const cache = new ProfileSubstringBlocklistCache();
		await cache.refresh();
		for (const scope of ['username', 'global_name', 'nickname'] as const) {
			expect(cache.containsBannedSubstring(scope, 'legacybad')).toBe(true);
			expect(cache.containsBannedSubstring(scope, 'allahverdi')).toBe(false);
		}
		const dictionary = await cache.loadUsernameDictionary(3, manifest.hash);
		expect(dictionary.contains('legacybad')).toBe(false);
		expect(dictionary.contains('allah')).toBe(true);
		expect(dictionary.contains('allahverdi')).toBe(false);
		cache.add('bio', 'biobad');
		expect(cache.containsBannedSubstring('pronouns', 'biobad')).toBe(false);
		cache.add('global_name', 'crossscope');
		expect(cache.isSubstringBanned('nickname', 'crossscope')).toBe(true);
		cache.remove('global_name', 'crossscope');
		expect(cache.isSubstringBanned('nickname', 'crossscope')).toBe(false);
	});
});
