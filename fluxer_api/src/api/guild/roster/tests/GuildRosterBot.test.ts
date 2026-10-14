// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {isGuildRosterLive, rosterBotApplicationId, rosterBotUserId} from '@app/api/guild/roster/GuildRosterBot';
import {ROSTER_CHECK_SUBS, ROSTER_TEXT} from '@app/api/guild/roster/GuildRosterConstants';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import {GuildRosterRateLimitConfigs} from '@app/api/rate_limit_configs/GuildRosterRateLimitConfig';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('Guild roster policy', () => {
	it('checks only the main roster at the event time', () => {
		expect(ROSTER_CHECK_SUBS).toBe(false);
	});
	it('preserves the event name casing in the announcement title', () => {
		expect(ROSTER_TEXT.title('İnformal iIıİ')).toBe('🚀 İnformal iIıİ İÇİN KATIL');
	});
});

describe('Guild roster rate limits', () => {
	it('scopes the list bucket to the guild', () => {
		expect(GuildRosterRateLimitConfigs.GUILD_ROSTER_EVENTS_LIST).toEqual({
			bucket: 'guild:roster:list::guild_id',
			config: {limit: 30, windowMs: 10_000},
		});
	});
	it('scopes the write bucket to the guild', () => {
		expect(GuildRosterRateLimitConfigs.GUILD_ROSTER_EVENTS_WRITE).toEqual({
			bucket: 'guild:roster:write::guild_id',
			config: {limit: 10, windowMs: 10_000},
		});
	});
});

describe('Guild roster bot', () => {
	let harness: ApiTestHarness;
	let previousId: string | undefined;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(() => {
		previousId = Config.instance.rosterBotApplicationId;
	});
	afterEach(() => {
		Config.instance.rosterBotApplicationId = previousId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	it('no application id → no bot and not live', () => {
		overrideLimits({feature_guild_roster: 1});
		for (const value of [undefined, '', ' ', 'not-a-number', '1.5', '-1']) {
			Config.instance.rosterBotApplicationId = value;
			expect(rosterBotApplicationId()).toBeNull();
			expect(rosterBotUserId()).toBeNull();
			expect(isGuildRosterLive(getLimitConfigService())).toBe(false);
		}
	});
	it('flag 0 → not live', () => {
		Config.instance.rosterBotApplicationId = '1490000000000000001';
		overrideLimits({feature_guild_roster: 0});
		expect(isGuildRosterLive(getLimitConfigService())).toBe(false);
	});
	it('flag 1 and id → live, bot user id equals the application id', () => {
		Config.instance.rosterBotApplicationId = '1490000000000000001';
		overrideLimits({feature_guild_roster: 1});
		expect(isGuildRosterLive(getLimitConfigService())).toBe(true);
		expect(rosterBotApplicationId()).toBe(1490000000000000001n);
		expect(rosterBotUserId()).toBe(rosterBotApplicationId());
	});
	it('parses an unchanged application id only once', () => {
		Config.instance.rosterBotApplicationId = '1490000000000000012';
		overrideLimits({feature_guild_roster: 1});
		const parse = vi.spyOn(SnowflakeType, 'safeParse');
		for (let attempt = 0; attempt < 10; attempt++) {
			expect(rosterBotApplicationId()).toBe(1490000000000000012n);
			expect(rosterBotUserId()).toBe(1490000000000000012n);
			expect(isGuildRosterLive(getLimitConfigService())).toBe(true);
		}
		expect(parse).toHaveBeenCalledTimes(1);
	});
	it('revalidates changed application ids and caches invalid values', () => {
		Config.instance.rosterBotApplicationId = '1490000000000000013';
		const parse = vi.spyOn(SnowflakeType, 'safeParse');
		expect(rosterBotApplicationId()).toBe(1490000000000000013n);
		Config.instance.rosterBotApplicationId = 'invalid-id';
		expect(rosterBotApplicationId()).toBeNull();
		expect(rosterBotUserId()).toBeNull();
		Config.instance.rosterBotApplicationId = '1490000000000000014';
		expect(rosterBotUserId()).toBe(1490000000000000014n);
		expect(parse).toHaveBeenCalledTimes(3);
	});
	// Worker service in the API process: APILifecycle.ts:171-181 (setInjectedWorkerService outside test mode).
});
