// SPDX-License-Identifier: AGPL-3.0-or-later

import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const guild = '42';
const ttl = 30 * 24 * 60 * 60;

describe('MicupBotLeaderboard', () => {
	let kv: MockKVProvider;
	let leaderboard: typeof import('@app/api/guild/micupbot/MicupBotLeaderboard');
	beforeEach(async () => {
		leaderboard = await import('@app/api/guild/micupbot/MicupBotLeaderboard');
		kv = new MockKVProvider();
	});
	afterEach(() => vi.restoreAllMocks());

	it('top returns the highest xp first with offset and limit', async () => {
		await leaderboard.leaderboardReplace(kv, guild, [
			{userId: 'a', xp: 10},
			{userId: 'b', xp: 90},
			{userId: 'c', xp: 40},
			{userId: 'd', xp: 60},
		]);
		expect(leaderboard.micupBotLeaderboardKey(guild)).toBe('micupbot:lb:42');
		expect(await leaderboard.leaderboardTop(kv, guild, 1, 2)).toEqual([
			{userId: 'd', xp: 60},
			{userId: 'c', xp: 40},
		]);
		expect(await leaderboard.leaderboardTop(kv, guild, 0, 0)).toEqual([]);
	});

	it('rank is 1-based and null past the top 1000', async () => {
		await kv.zadd(
			leaderboard.micupBotLeaderboardKey(guild),
			...Array.from({length: 1002}, (_, i) => [i, String(i)]).flat(),
		);
		expect(await leaderboard.leaderboardRank(kv, guild, '1001')).toBe(1);
		expect(await leaderboard.leaderboardRank(kv, guild, '2')).toBe(1000);
		expect(await leaderboard.leaderboardRank(kv, guild, '1')).toBeNull();
		expect(await leaderboard.leaderboardRank(kv, guild, 'missing')).toBeNull();
		expect(await leaderboard.leaderboardTop(kv, guild, 999, 100)).toEqual([{userId: '2', xp: 2}]);
		expect(await leaderboard.leaderboardTop(kv, guild, 1000, 1)).toEqual([]);
	});

	it('add trims the set back to 1000', async () => {
		await kv.zadd(
			leaderboard.micupBotLeaderboardKey(guild),
			...Array.from({length: 1005}, (_, i) => [i, String(i)]).flat(),
		);
		const trim = vi.spyOn(kv, 'zremrangebyrank');
		await leaderboard.leaderboardAdd(kv, guild, 'leader', 9999, () => 0.01);
		expect(trim).not.toHaveBeenCalled();
		await leaderboard.leaderboardAdd(kv, guild, 'leader', 9999, () => 0);
		expect(await kv.zcard(leaderboard.micupBotLeaderboardKey(guild))).toBe(leaderboard.MICUPBOT_LEADERBOARD_SIZE);
		expect(await leaderboard.leaderboardRank(kv, guild, 'leader')).toBe(1);
		expect(await leaderboard.leaderboardRank(kv, guild, '0')).toBeNull();
	});

	it('replace swaps the whole set', async () => {
		await leaderboard.leaderboardAdd(kv, guild, 'old', 900, () => 1);
		const entries = Array.from({length: 1003}, (_, i) => ({userId: String(i), xp: i}));
		await leaderboard.leaderboardReplace(kv, guild, entries);
		expect(await leaderboard.leaderboardRank(kv, guild, 'old')).toBeNull();
		expect(await leaderboard.leaderboardCount(kv, guild)).toBe(1000);
		expect(await leaderboard.leaderboardExists(kv, guild)).toBe(true);
		await leaderboard.leaderboardReplace(kv, guild, []);
		expect(await leaderboard.leaderboardCount(kv, guild)).toBe(0);
		expect(await leaderboard.leaderboardExists(kv, guild)).toBe(false);
	});

	it('remove drops one member', async () => {
		await leaderboard.leaderboardReplace(kv, guild, [
			{userId: 'a', xp: 10},
			{userId: 'b', xp: 20},
		]);
		await leaderboard.leaderboardRemove(kv, guild, 'b');
		expect(await leaderboard.leaderboardTop(kv, guild, 0, 10)).toEqual([{userId: 'a', xp: 10}]);
	});

	it('the leaderboard key carries a 30 day TTL after a trim or a rebuild', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
		await leaderboard.leaderboardAdd(kv, guild, 'a', 10, () => 0);
		expect(await kv.ttl(leaderboard.micupBotLeaderboardKey(guild))).toBe(ttl);
		await leaderboard.leaderboardReplace(kv, guild, [{userId: 'b', xp: 20}]);
		expect(await kv.ttl(leaderboard.micupBotLeaderboardKey(guild))).toBe(ttl);
		vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + ttl * 1000 + 1);
		expect(await leaderboard.leaderboardExists(kv, guild)).toBe(false);
	});
});
