// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import {MICUPBOT_XP_COUNTER, MICUPBOT_XP_DIRTY_SET, micupBotXpCounterId} from '@app/api/database/types/MicupBotTypes';
import {leaderboardAdd, leaderboardRank} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import {registerMicupBotUserLifecycleHooks} from '@app/api/guild/micupbot/MicupBotUserLifecycleHooks';
import {GUILD, levelsFixture, USER} from '@app/api/guild/micupbot/tests/MicupBotLevelsTestUtils';
import {
	counterDirtyKey,
	counterInflightKey,
	counterKey,
	counterPartition,
} from '@app/api/infrastructure/KVCounterService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import * as Hooks from '@app/api/user/lifecycle/UserLifecycleHooks';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	await harness.reset();
	registerMicupBotUserLifecycleHooks();
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

it('account deletion removes levels, warnings, leaderboard entries and KV counters in every community, including left ones', async () => {
	const {repository, counterService, kvClient} = levelsFixture();
	const guilds = [GUILD, createGuildID(21n << 22n)];
	for (const guild of guilds) {
		await repository.setMemberXp(guild, USER, 100n);
		await counterService.add(MICUPBOT_XP_COUNTER, micupBotXpCounterId(guild, USER), 20);
		await leaderboardAdd(kvClient, guild, USER, 120);
		await repository.addWarning({
			guild_id: guild,
			user_id: USER,
			warning_id: 1n,
			moderator_id: USER,
			reason: 'Test reason',
			created_at: new Date(),
		});
	}
	await Hooks.runUserDeletionHook('micupbot', {userId: USER});
	await Hooks.runUserDeletionHook('micupbot', {userId: USER});
	for (const guild of guilds) {
		expect(await repository.getMemberXp(guild, USER)).toBeNull();
		expect(await repository.listWarnings(guild, USER, 100)).toEqual([]);
		expect(await leaderboardRank(kvClient, guild, USER)).toBeNull();
		expect(await kvClient.get(counterKey(MICUPBOT_XP_COUNTER, micupBotXpCounterId(guild, USER)))).toBeNull();
	}
	expect(await repository.listUserGuilds(USER)).toEqual([]);
});

it('a flush after account deletion cannot recreate the member row', async () => {
	const {repository, counterService, kvClient} = levelsFixture();
	const id = micupBotXpCounterId(GUILD, USER);
	const partition = counterPartition(MICUPBOT_XP_COUNTER, id);
	const dirtyKey = counterDirtyKey(partition, MICUPBOT_XP_DIRTY_SET);
	await repository.addUserGuild(USER, GUILD);
	await counterService.add(MICUPBOT_XP_COUNTER, id, 50);
	const remove = vi.spyOn(kvClient, 'srem');
	const del = vi.spyOn(kvClient, 'del');
	await Hooks.runUserDeletionHook('micupbot', {userId: USER});
	expect(remove).toHaveBeenCalledWith(dirtyKey, `${MICUPBOT_XP_COUNTER}:${id}`);
	expect(remove.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]!);
	expect(await kvClient.scard(dirtyKey)).toBe(0);
	await counterService.flushPartition(partition, 1000, MICUPBOT_XP_DIRTY_SET);
	expect(await repository.getMemberXp(GUILD, USER)).toBeNull();
});

it('the export lists xp, level and warnings without the moderator', async () => {
	const {repository, counterService} = levelsFixture();
	await repository.setMemberXp(GUILD, USER, 100n);
	await counterService.add(MICUPBOT_XP_COUNTER, micupBotXpCounterId(GUILD, USER), 25);
	const createdAt = new Date('2026-10-02T00:00:00Z');
	await repository.addWarning({
		guild_id: GUILD,
		user_id: USER,
		warning_id: 1n,
		moderator_id: USER,
		reason: 'Test warning',
		created_at: createdAt,
	});
	const register = vi.spyOn(Hooks, 'registerUserHarvestHook');
	registerMicupBotUserLifecycleHooks();
	expect(register).toHaveBeenCalledWith('micupbot', expect.any(Function));
	const hook = register.mock.calls.find(([name]) => name === 'micupbot')![1];
	const exported = await hook({userId: USER});
	expect(exported).toEqual([
		{
			guild_id: String(GUILD),
			xp: 125,
			level: 1,
			warnings: [{reason: 'Test warning', created_at: createdAt.toISOString()}],
		},
	]);
	expect(JSON.stringify(exported)).not.toContain('moderator');
});

it('deletion retries while an xp flush is in flight and removes its leftover claim', async () => {
	const {repository, counterService, kvClient} = levelsFixture();
	const id = micupBotXpCounterId(GUILD, USER);
	const partition = counterPartition(MICUPBOT_XP_COUNTER, id);
	const lockKey = `job:flushCounters:${MICUPBOT_XP_DIRTY_SET}:{${partition}}`;
	await repository.addUserGuild(USER, GUILD);
	await counterService.add(MICUPBOT_XP_COUNTER, id, 50);
	await kvClient.acquireLock(lockKey, 'flusher', 60);
	await kvClient.counterClaim(
		counterDirtyKey(partition, MICUPBOT_XP_DIRTY_SET),
		counterInflightKey(partition, MICUPBOT_XP_DIRTY_SET),
		1000,
	);
	await expect(Hooks.runUserDeletionHook('micupbot', {userId: USER})).rejects.toThrow();
	expect(await repository.listUserGuilds(USER)).toEqual([GUILD]);
	await kvClient.releaseLock(lockKey, 'flusher');
	await Hooks.runUserDeletionHook('micupbot', {userId: USER});
	expect(await kvClient.scard(counterInflightKey(partition, MICUPBOT_XP_DIRTY_SET))).toBe(0);
	await counterService.flushPartition(partition, 1000, MICUPBOT_XP_DIRTY_SET);
	expect(await repository.getMemberXp(GUILD, USER)).toBeNull();
});
