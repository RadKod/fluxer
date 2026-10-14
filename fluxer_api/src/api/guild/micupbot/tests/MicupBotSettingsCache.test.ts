// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createRoleID, type GuildID} from '@app/api/BrandedTypes';
import {getMicupBotGuildConfig, invalidateMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {drainHook, NOW, rule, settings} from '@app/api/guild/micupbot/tests/MicupBotHookTestUtils';
import {getCacheService, getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('MicupBotSettingsCache', () => {
	let harness: ApiTestHarness;
	let ids: Array<GuildID>;
	let sequence = 820000000000000000n;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		ids = [];
	});
	afterEach(async () => {
		for (const id of ids) await invalidateMicupBotGuildConfig(id);
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness.shutdown();
	});
	function guildId() {
		const id = createGuildID(++sequence);
		ids.push(id);
		return id;
	}
	function spies() {
		return {
			read: vi.spyOn(getMicupBotRepository(), 'getSettings').mockImplementation(async (id) => settings({guild_id: id})),
			rules: vi
				.spyOn(getMicupBotRepository(), 'listRules')
				.mockImplementation(async (id) => [rule({guild_id: id, exempt_role_ids: new Set([createRoleID(12n)])})]),
			shared: vi.spyOn(getCacheService(), 'getEntry'),
		};
	}
	it('a second read in 30 s does no IO', async () => {
		const {read, rules, shared} = spies();
		const id = guildId();
		const first = await getMicupBotGuildConfig(id);
		read.mockClear();
		rules.mockClear();
		shared.mockClear();
		expect(await getMicupBotGuildConfig(id)).toEqual(first);
		expect(read).not.toHaveBeenCalled();
		expect(rules).not.toHaveBeenCalled();
		expect(shared).not.toHaveBeenCalled();
	});
	it('negative results are cached and concurrent misses share one read', async () => {
		const {read, rules, shared} = spies();
		read.mockResolvedValue(null);
		const id = guildId();
		expect(await Promise.all(Array.from({length: 20}, () => getMicupBotGuildConfig(id)))).toEqual(Array(20).fill(null));
		expect(read).toHaveBeenCalledTimes(1);
		expect(rules).not.toHaveBeenCalled();
		expect(shared).toHaveBeenCalledTimes(1);
		await getMicupBotGuildConfig(id);
		expect(shared).toHaveBeenCalledTimes(1);
	});
	it('a stale shared snapshot expires within 30 seconds', async () => {
		const {read, rules} = spies();
		const id = guildId();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
		await getMicupBotGuildConfig(id);
		read.mockResolvedValue(settings({guild_id: id, version: 2}));
		clock.mockReturnValue(NOW + 30_001);
		expect((await getMicupBotGuildConfig(id))?.settings.version).toBe(2);
		expect(read).toHaveBeenCalledTimes(2);
		expect(rules).toHaveBeenCalledTimes(2);
	});
	it('the shared cache restores bigint, sets and dates after local eviction', async () => {
		const {read, shared} = spies();
		const id = guildId();
		const first = await getMicupBotGuildConfig(id);
		const json = await getCacheService().get<string>(`micupbot:settings:${id}`);
		await invalidateMicupBotGuildConfig(id);
		await getCacheService().set(`micupbot:settings:${id}`, json, 30);
		expect(await getMicupBotGuildConfig(id)).toEqual(first);
		expect(read).toHaveBeenCalledTimes(1);
		expect(shared).toHaveBeenCalledTimes(3);
	});
	it('invalidate drops the shared copy', async () => {
		const {read} = spies();
		const id = guildId();
		await getMicupBotGuildConfig(id);
		await invalidateMicupBotGuildConfig(id);
		expect(await getCacheService().getEntry(`micupbot:settings:${id}`)).toEqual({hit: false});
		await getMicupBotGuildConfig(id);
		expect(read).toHaveBeenCalledTimes(2);
	});
	it('invalidation during a read does not repopulate stale settings', async () => {
		const {read} = spies();
		const id = guildId();
		let release!: (row: ReturnType<typeof settings>) => void;
		read.mockReturnValueOnce(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const pending = getMicupBotGuildConfig(id);
		await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
		const invalidation = invalidateMicupBotGuildConfig(id);
		release(settings({guild_id: id, version: 1}));
		await pending;
		await invalidation;
		read.mockResolvedValue(settings({guild_id: id, version: 2}));
		expect((await getMicupBotGuildConfig(id))?.settings.version).toBe(2);
	});
	it('at most 50 000 entries', async () => {
		const {read, shared} = spies();
		read.mockResolvedValue(null);
		shared.mockResolvedValue({hit: false});
		vi.spyOn(getCacheService(), 'set').mockResolvedValue(undefined);
		vi.spyOn(getCacheService(), 'delete').mockResolvedValue(undefined);
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const first = guildId();
		await getMicupBotGuildConfig(first);
		for (let i = 0; i < 50_000; i++) await getMicupBotGuildConfig(guildId());
		read.mockClear();
		await getMicupBotGuildConfig(ids[ids.length - 1]!);
		expect(read).not.toHaveBeenCalled();
		await getMicupBotGuildConfig(first);
		expect(read).toHaveBeenCalledTimes(1);
	});
	it('a read during shared invalidation waits for the fresh version', async () => {
		const {read} = spies();
		const id = guildId();
		await getMicupBotGuildConfig(id);
		read.mockResolvedValue(settings({guild_id: id, version: 2}));
		const cache = getCacheService();
		const deleteEntry = cache.delete.bind(cache);
		let release!: () => void;
		vi.spyOn(cache, 'delete').mockImplementationOnce(async (key) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			await deleteEntry(key);
		});
		const invalidation = invalidateMicupBotGuildConfig(id);
		const next = getMicupBotGuildConfig(id);
		await drainHook();
		release();
		await invalidation;
		expect((await next)?.settings.version).toBe(2);
	});
	it('the cache never holds more than its byte budget', async () => {
		const {read, rules, shared} = spies();
		shared.mockResolvedValue({hit: false});
		vi.spyOn(getCacheService(), 'set').mockResolvedValue(undefined);
		vi.spyOn(getCacheService(), 'delete').mockResolvedValue(undefined);
		vi.spyOn(Date, 'now').mockReturnValue(NOW);
		const words = new Set(Array.from({length: 200}, (_, i) => `${i}`.padEnd(64, 'x')));
		rules.mockImplementation(async (id) =>
			['spam', 'invites', 'links', 'words', 'mentions', 'caps'].map((name) =>
				rule({guild_id: id, rule: name as ReturnType<typeof rule>['rule'], words}),
			),
		);
		const first = guildId();
		await getMicupBotGuildConfig(first);
		// Words alone occupy this many UTF-16 JSON bytes, excluding keys, IDs and entry overhead.
		const minimumBytes = 200 * 64 * 6 * 2;
		for (let i = 0; i < Math.ceil((64 * 1024 * 1024) / minimumBytes); i++) await getMicupBotGuildConfig(guildId());
		read.mockClear();
		await getMicupBotGuildConfig(ids[ids.length - 1]!);
		expect(read).not.toHaveBeenCalled();
		await getMicupBotGuildConfig(first);
		expect(read).toHaveBeenCalledTimes(1);
	});
});
