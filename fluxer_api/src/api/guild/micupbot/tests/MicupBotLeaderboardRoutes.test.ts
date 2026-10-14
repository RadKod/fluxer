// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import {leaderboardReplace} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import {createMicupBotFixture, type MicupBotFixture} from '@app/api/guild/micupbot/tests/MicupBotTestUtils';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getUserCacheService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {MicupBotLeaderboardResponse} from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
let f: MicupBotFixture;
let originalId: string | undefined;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	originalId = Config.instance.micupBotApplicationId;
	await harness.reset();
	f = await createMicupBotFixture(harness);
});
afterEach(() => {
	Config.instance.micupBotApplicationId = originalId;
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

it('any member reads the leaderboard, a non-member gets 403', async () => {
	const member = await f.member();
	const outsider = await createTestAccount(harness);
	const jobs = vi.spyOn(getWorkerService(), 'addJob');
	expect(await createBuilder(harness, member.token).get(`${f.base}/leaderboard`).execute()).toEqual({
		levels_enabled: false,
		total: 0,
		entries: [],
	});
	expect(jobs).not.toHaveBeenCalled();
	await createBuilder(harness, outsider.token).get(`${f.base}/leaderboard`).expect(403).execute();
});

it('an empty key queues one rebuild and answers an empty list', async () => {
	await f.seedSettings({levels_enabled: true});
	const jobs = vi.spyOn(getWorkerService(), 'addJob');
	const get = () => createBuilder(harness, f.owner.token).get(`${f.base}/leaderboard`).execute();
	expect(await get()).toEqual({levels_enabled: true, total: 0, entries: []});
	expect(jobs).toHaveBeenCalledExactlyOnceWith(
		'rebuildMicupBotLeaderboard',
		{guild_id: f.guild.id},
		{jobKey: `lbr:${f.guild.id}`, skipLedger: true},
	);
	jobs.mockRejectedValueOnce(new Error('Queue unavailable'));
	expect(await get()).toEqual({levels_enabled: true, total: 0, entries: []});
});

it('entries carry rank, level and the user', async () => {
	const member = await f.member();
	await f.seedSettings({levels_enabled: true});
	await leaderboardReplace(getKVClient(), f.guildId, [
		{userId: f.owner.userId, xp: 1000},
		{userId: member.userId, xp: 100},
	]);
	const users = vi.spyOn(getUserCacheService(), 'getUserPartialResponses');
	const result = await createBuilder<MicupBotLeaderboardResponse>(harness, member.token)
		.get(`${f.base}/leaderboard?offset=1&limit=1`)
		.execute();
	expect(result.total).toBe(2);
	expect(result.entries).toHaveLength(1);
	expect(result.entries[0]).toMatchObject({
		rank: 2,
		user_id: member.userId,
		xp: 100,
		level: 1,
		user: {id: member.userId},
	});
	expect(result.entries[0]!.user).not.toHaveProperty('email');
	expect(users).toHaveBeenCalledTimes(1);
});

it('repeated leaderboard reads use cached guild settings', async () => {
	await f.seedSettings({levels_enabled: true});
	await leaderboardReplace(getKVClient(), f.guildId, [{userId: f.owner.userId, xp: 100}]);
	const settings = vi.spyOn(f.repository, 'getSettings');
	const get = () =>
		createBuilder<MicupBotLeaderboardResponse>(harness, f.owner.token).get(`${f.base}/leaderboard`).execute();
	expect((await get()).entries).toHaveLength(1);
	expect((await get()).entries).toHaveLength(1);
	expect(settings).toHaveBeenCalledTimes(1);
	await f.patch({levels_enabled: false}).execute();
	expect(await get()).toEqual({levels_enabled: false, total: 0, entries: []});
});
