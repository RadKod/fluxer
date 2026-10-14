// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {MICUPBOT_XP_COUNTER, micupBotXpCounterId} from '@app/api/database/types/MicupBotTypes';
import {
	leaderboardExists,
	leaderboardRank,
	leaderboardReplace,
	leaderboardTop,
	micupBotLeaderboardKey,
} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {CHANNEL, GUILD, levelsFixture, USER} from '@app/api/guild/micupbot/tests/MicupBotLevelsTestUtils';
import {Logger} from '@app/api/Logger';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	await harness.reset();
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});
const award = {guildId: GUILD, userId: USER, channelId: CHANNEL, xp: 20, source: 'message' as const};

it('award gives xp once per 60 s per member', async () => {
	const {levels} = levelsFixture();
	let now = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	expect(await levels.award(award)).toEqual({xp: 20, level: 0, leveledUp: false});
	expect(await levels.award(award)).toBeNull();
	expect((await levels.award({...award, userId: createUserID(4n)}))?.xp).toBe(20);
	now += 59_999;
	expect(await levels.award(award)).toBeNull();
	now += 1;
	expect((await levels.award(award))?.xp).toBe(40);
});

it('award adds the member to the leaderboard', async () => {
	const {levels, kvClient, repository} = levelsFixture();
	await leaderboardReplace(kvClient, GUILD, [{userId: createUserID(4n), xp: 10}]);
	const write = vi.spyOn(repository, 'setMemberXp');
	await levels.award(award);
	expect(await leaderboardRank(kvClient, GUILD, USER)).toBe(1);
	expect(await levels.getMemberStats(GUILD, USER)).toEqual({xp: 20, level: 0, current: 20, next: 100, rank: 1});
	expect(write).not.toHaveBeenCalled();
});

it('an expired leaderboard is rebuilt, not restarted by one award', async () => {
	const {levels, kvClient, repository, workerService} = levelsFixture();
	const leader = createUserID(4n << 22n);
	await repository.setMemberXp(GUILD, leader, 200n);
	await repository.setMemberXp(GUILD, USER, 40n);
	let now = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	await leaderboardReplace(kvClient, GUILD, [
		{userId: leader, xp: 200},
		{userId: USER, xp: 40},
	]);
	now += 30 * 24 * 60 * 60 * 1000 + 1;
	expect(await leaderboardExists(kvClient, GUILD)).toBe(false);
	const jobs = vi.spyOn(workerService, 'addJob');
	expect(await levels.award(award)).toEqual({xp: 60, level: 0, leveledUp: false});
	expect(await leaderboardExists(kvClient, GUILD)).toBe(false);
	expect(jobs).toHaveBeenCalledExactlyOnceWith(
		'rebuildMicupBotLeaderboard',
		{guild_id: String(GUILD)},
		{jobKey: `lbr:${GUILD}`, skipLedger: true},
	);
	await levels.rebuildLeaderboard({guild_id: String(GUILD)});
	expect(await leaderboardTop(kvClient, GUILD, 0, 10)).toEqual([
		{userId: String(leader), xp: 200},
		{userId: String(USER), xp: 40},
	]);
	expect((await levels.getMemberStats(GUILD, USER)).xp).toBe(60);
});

it('every award refreshes an existing leaderboard for 30 days without a trim', async () => {
	const {levels, kvClient, workerService} = levelsFixture();
	let now = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	vi.spyOn(Math, 'random').mockReturnValue(0.5);
	const key = micupBotLeaderboardKey(GUILD);
	await leaderboardReplace(kvClient, GUILD, [{userId: USER, xp: 0}]);
	now += 24 * 60 * 60 * 1000;
	const jobs = vi.spyOn(workerService, 'addJob');
	const trim = vi.spyOn(kvClient, 'zremrangebyrank');
	await levels.award(award);
	expect(await kvClient.ttl(key)).toBe(30 * 24 * 60 * 60);
	expect(await leaderboardTop(kvClient, GUILD, 0, 10)).toEqual([{userId: String(USER), xp: 20}]);
	expect(trim).not.toHaveBeenCalled();
	expect(jobs).not.toHaveBeenCalled();
});

it('crossing a threshold queues one level-up job keyed by level', async () => {
	const {levels, counterService, workerService, kvClient} = levelsFixture();
	await leaderboardReplace(kvClient, GUILD, [{userId: USER, xp: 90}]);
	await counterService.add(MICUPBOT_XP_COUNTER, micupBotXpCounterId(GUILD, USER), 90);
	const jobs = vi.spyOn(workerService, 'addJob');
	await levels.award(award);
	await levels.award({...award, source: 'voice'});
	expect(jobs).toHaveBeenCalledExactlyOnceWith(
		'handleMicupBotLevelUp',
		{guild_id: String(GUILD), user_id: String(USER), channel_id: String(CHANNEL), level: 1, at: expect.any(Number)},
		{jobKey: `lv:${GUILD}:${USER}:1`, skipLedger: true},
	);
});

it('voice awards skip the cooldown', async () => {
	const {levels, kvClient} = levelsFixture();
	await levels.award(award);
	const cooldown = vi.spyOn(kvClient, 'setnx');
	expect((await levels.award({...award, source: 'voice', channelId: null}))?.xp).toBe(40);
	expect((await levels.award({...award, source: 'voice', channelId: null}))?.xp).toBe(60);
	expect(cooldown).not.toHaveBeenCalled();
});

it('only the first xp award writes the user guild index', async () => {
	const {levels, repository} = levelsFixture();
	const index = vi.spyOn(repository, 'addUserGuild');
	await levels.getMemberStats(GUILD, USER);
	expect(index).not.toHaveBeenCalled();
	await levels.award(award);
	await levels.award({...award, source: 'voice'});
	expect(index).toHaveBeenCalledExactlyOnceWith(USER, GUILD);
});

it('index or queue failures keep awarded xp and are logged', async () => {
	const f = levelsFixture();
	await leaderboardReplace(f.kvClient, GUILD, [{userId: createUserID(4n), xp: 10}]);
	vi.spyOn(f.repository, 'addUserGuild').mockRejectedValue(new Error('index unavailable'));
	const warn = vi.spyOn(Logger.child({}), 'warn');
	const levels = createMicupBotLevels({
		...f,
		workerService: () => {
			throw new Error('queue unavailable');
		},
	});
	expect(await levels.award({...award, xp: 110})).toEqual({xp: 110, level: 1, leveledUp: true});
	expect((await levels.getMemberStats(GUILD, USER)).xp).toBe(110);
	expect(warn).toHaveBeenCalledTimes(2);
});

it('member stats read stored xp and return a null rank outside the leaderboard', async () => {
	const {levels, repository} = levelsFixture();
	await repository.setMemberXp(GUILD, USER, 125n);
	expect(await levels.getMemberStats(GUILD, USER)).toEqual({xp: 125, level: 1, current: 25, next: 155, rank: null});
});

it('a rebuild queue failure keeps awarded xp and the missing leaderboard retryable', async () => {
	const {levels, kvClient, workerService} = levelsFixture();
	vi.spyOn(workerService, 'addJob').mockRejectedValueOnce(new Error('queue unavailable'));
	const warn = vi.spyOn(Logger.child({}), 'warn');
	expect(await levels.award(award)).toEqual({xp: 20, level: 0, leveledUp: false});
	expect(await leaderboardExists(kvClient, GUILD)).toBe(false);
	expect(warn).toHaveBeenCalledWith(
		expect.objectContaining({guildId: String(GUILD)}),
		'Failed to queue MicupBOT leaderboard rebuild',
	);
	expect((await levels.getMemberStats(GUILD, USER)).xp).toBe(20);
});
