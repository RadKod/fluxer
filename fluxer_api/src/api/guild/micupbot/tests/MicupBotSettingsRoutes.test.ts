// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import {micupBotSlotOf} from '@app/api/database/types/MicupBotTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_LIMITS, MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import * as MessageHook from '@app/api/guild/micupbot/MicupBotMessageHook';
import * as SettingsCache from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {
	createMicupBotFixture,
	type MicupBotFixture,
	micupBotRoutes,
} from '@app/api/guild/micupbot/tests/MicupBotTestUtils';
import {getGatewayService, getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getGuildRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {createWebhook, executeWebhook} from '@app/api/webhook/tests/WebhookTestUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {GuildFeatures, GuildMFALevel, SystemChannelFlags} from '@fluxer/constants/src/GuildConstants';
import type {WellKnownFluxerResponse} from '@fluxer/schema/src/domains/instance/InstanceSchemas';
import {
	type MicupBotAutomodResponse,
	MicupBotSettingsResponse,
} from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';
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

it('the message hook runs for normal messages and excludes personal notes and webhooks', async () => {
	const hook = vi.spyOn(MessageHook, 'notifyMicupBotMessage');
	await createBuilder(harness, f.owner.token)
		.post(`/channels/${f.channelId}/messages`)
		.body({content: 'Hello'})
		.execute();
	expect(hook).toHaveBeenCalledTimes(1);
	expect(hook.mock.calls[0]![0].message.content).toBe('Hello');
	await createBuilder(harness, f.owner.token)
		.post(`/channels/${f.owner.userId}/messages`)
		.body({content: 'Note'})
		.execute();
	const webhook = await createWebhook(harness, f.channelId.toString(), f.owner.token, 'Hook probe');
	await executeWebhook(harness, webhook.id, webhook.token!, {content: 'Webhook'});
	expect(hook).toHaveBeenCalledTimes(1);
});

it('every route answers 403 without its permission', async () => {
	const member = await f.member();
	const outsider = await createTestAccount(harness);
	for (const [method, path, body] of micupBotRoutes(f)) {
		const token = path === 'leaderboard' ? outsider.token : member.token;
		const request = createBuilder(harness, token)[method](`${f.base}/${path}`);
		if (body) request.body(body);
		await request.expect(403).execute();
	}
});

it('OAuth2 bearer and bot tokens are refused', async () => {
	const oauth = await createBuilder<{token: string}>(harness, '')
		.post('/test/oauth2/access-token')
		.body({user_id: f.owner.userId, scopes: ['identify']})
		.execute();
	const bot = await createTestBotAccount(harness);
	for (const token of [`Bearer ${oauth.token}`, `Bot ${bot.botToken}`]) {
		for (const [method, path, body] of micupBotRoutes(f)) {
			const request = createBuilder(harness, token)[method](`${f.base}/${path}`);
			if (body) request.body(body);
			await request.expect(403).execute();
		}
	}
});

it('writes answer 403 FEATURE_TEMPORARILY_DISABLED while feature_micupbot is 0 and GETs still answer', async () => {
	overrideLimits({feature_micupbot: 0});
	for (const [method, path, body] of micupBotRoutes(f)) {
		const request = createBuilder(harness, f.owner.token)[method](`${f.base}/${path}`);
		if (body) request.body(body);
		await (method === 'get' ? request : request.expect(403, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)).execute();
	}
	expect((await f.get().execute()).feature_enabled).toBe(false);
	expect(await f.repository.getSettings(f.guildId)).toBeNull();
});

it('GET shows bot null without an application and in_guild once the bot joins', async () => {
	Config.instance.micupBotApplicationId = undefined;
	const empty = await f.get().execute();
	expect(MicupBotSettingsResponse.safeParse(empty).success).toBe(true);
	expect(empty.bot).toBeNull();
	expect(empty.feature_enabled).toBe(false);
	expect(empty.invite_permissions).toBe('1099780156480');
	expect(empty.limits).toEqual(MICUPBOT_LIMITS);
	expect(empty.default_messages).toEqual({
		welcome: MICUPBOT_TEXT.defaultWelcome,
		goodbye: MICUPBOT_TEXT.defaultGoodbye,
		level_up: MICUPBOT_TEXT.defaultLevelUp,
	});
	expect(empty.settings).toMatchObject({
		commands_enabled: false,
		levels_enabled: false,
		automod_enabled: false,
		level_up_message_enabled: true,
		updated_at: null,
	});
	Config.instance.micupBotApplicationId = '1490000000000000001';
	expect((await f.get().execute()).bot?.in_guild).toBe(false);
	const bot = await f.addBot();
	expect((await f.get().execute()).bot).toEqual({
		application_id: bot.application.id,
		user_id: bot.botUserId,
		in_guild: true,
		mfa_blocked: false,
	});
});

it('bot.mfa_blocked is true on an elevated-MFA community', async () => {
	const repo = getGuildRepository();
	const guild = (await repo.findUnique(f.guildId))!;
	await repo.upsertPartial(f.guildId, {mfa_level: GuildMFALevel.ELEVATED}, guild.toRow());
	expect((await f.get().execute()).bot?.mfa_blocked).toBe(true);
});

it("join_notification_conflict is true when the welcome channel gets Fluxer's join message", async () => {
	await f.seedSettings({welcome_enabled: true, welcome_channel_id: f.channelId});
	expect((await f.get().execute()).join_notification_conflict).toBe(true);
	const repo = getGuildRepository();
	const guild = (await repo.findUnique(f.guildId))!;
	await repo.upsertPartial(
		f.guildId,
		{system_channel_flags: SystemChannelFlags.SUPPRESS_JOIN_NOTIFICATIONS},
		guild.toRow(),
	);
	expect((await f.get().execute()).join_notification_conflict).toBe(false);
});

it('module flags follow the settings while the bot is a member', async () => {
	await f.addBot();
	const dispatch = vi.spyOn(getGatewayService(), 'dispatchGuild');
	const invalidate = vi.spyOn(SettingsCache, 'invalidateMicupBotGuildConfig');
	await f
		.patch({
			commands_enabled: true,
			levels_enabled: true,
			voice_xp_enabled: true,
			welcome_enabled: true,
			welcome_channel_id: f.channelId.toString(),
		})
		.execute();
	const features = (await getGuildRepository().findUnique(f.guildId))!.features;
	expect(features).toEqual(expect.objectContaining({size: expect.any(Number)}));
	for (const flag of [GuildFeatures.MICUPBOT_COMMANDS, GuildFeatures.MICUPBOT_LEVELS, GuildFeatures.MICUPBOT_JOIN])
		expect(features.has(flag)).toBe(true);
	expect(features.has(GuildFeatures.MICUPBOT_AUTOMOD)).toBe(false);
	expect(dispatch.mock.calls.filter(([p]) => p.event === 'GUILD_UPDATE')).toHaveLength(1);
	expect(await f.repository.listVoiceSlot(micupBotSlotOf(f.guildId), null, 10)).toContain(f.guildId);
	expect(invalidate).toHaveBeenCalledWith(f.guildId);
	dispatch.mockClear();
	await f.patch({welcome_message: 'Welcome'}).execute();
	expect(dispatch.mock.calls.filter(([p]) => p.event === 'GUILD_UPDATE')).toHaveLength(0);
	await getKVClient().del(`micupbot:mod:${f.guildId}`);
	await f.patch({commands_enabled: false, levels_enabled: false, welcome_enabled: false}).execute();
	expect(
		[...(await getGuildRepository().findUnique(f.guildId))!.features].filter((v) => v.startsWith('MICUPBOT_')),
	).toEqual([]);
	expect(await f.repository.listVoiceSlot(micupBotSlotOf(f.guildId), null, 10)).not.toContain(f.guildId);
});

it('a second module change within 60 s answers 429', async () => {
	await f.addBot();
	await f.patch({commands_enabled: true}).execute();
	const {response, json} = await f.patch({levels_enabled: true}).executeRaw();
	expect(response.status).toBe(429);
	expect(json).toMatchObject({code: APIErrorCodes.RATE_LIMITED, retry_after: expect.any(Number)});
	expect((json as unknown as {retry_after: number}).retry_after).toBeLessThanOrEqual(60);
	expect((await f.repository.getSettings(f.guildId))?.levels_enabled).toBe(false);
});

it('flags are not written while the bot is not a member', async () => {
	await f.patch({commands_enabled: true, levels_enabled: true}).execute();
	expect(
		[...(await getGuildRepository().findUnique(f.guildId))!.features].filter((v) => v.startsWith('MICUPBOT_')),
	).toEqual([]);
});

it('PATCH retries once on a version clash', async () => {
	await f.seedSettings();
	const put = f.repository.putSettings.bind(f.repository);
	const spy = vi.spyOn(f.repository, 'putSettings').mockImplementationOnce(async (row) => {
		await put({...row, commands_enabled: true, welcome_message: null}, 0);
		return false;
	});
	const result = await f.patch({welcome_message: 'Hello'}).execute();
	expect(result.settings).toMatchObject({commands_enabled: true, welcome_message: 'Hello'});
	expect(spy).toHaveBeenCalledTimes(2);
	expect((await f.repository.getSettings(f.guildId))?.updated_by).toBe(createUserID(BigInt(f.owner.userId)));
	spy.mockReset().mockResolvedValue(false);
	await f.patch({goodbye_message: 'Goodbye'}).expect(423, APIErrorCodes.GENERAL_ERROR).execute();
	expect(spy).toHaveBeenCalledTimes(2);
});

it('enabling the first automod rule sets MICUPBOT_AUTOMOD and disabling the last clears it', async () => {
	await f.addBot();
	await f.patch({automod_enabled: true}).execute();
	const put = (enabled: boolean) =>
		createBuilder<MicupBotAutomodResponse>(harness, f.owner.token)
			.put(`${f.base}/automod`)
			.body({rules: [{rule: 'spam', enabled, threshold: 5}]});
	await put(true).execute();
	expect((await getGuildRepository().findUnique(f.guildId))!.features.has(GuildFeatures.MICUPBOT_AUTOMOD)).toBe(true);
	await put(false).expect(429, APIErrorCodes.RATE_LIMITED).execute();
	expect((await f.repository.listRules(f.guildId))[0]!.enabled).toBe(true);
	await getKVClient().del(`micupbot:mod:${f.guildId}`);
	await put(false).execute();
	expect((await getGuildRepository().findUnique(f.guildId))!.features.has(GuildFeatures.MICUPBOT_AUTOMOD)).toBe(false);
});

it('a later PATCH repairs flags left out of sync', async () => {
	await f.addBot();
	await f.seedSettings({commands_enabled: true});
	expect((await getGuildRepository().findUnique(f.guildId))!.features.has(GuildFeatures.MICUPBOT_COMMANDS)).toBe(false);
	await f.patch({welcome_message: 'Repair'}).execute();
	expect((await getGuildRepository().findUnique(f.guildId))!.features.has(GuildFeatures.MICUPBOT_COMMANDS)).toBe(true);
});

it('automod GET fills defaults and PUT replaces all saved rules', async () => {
	const get = () => createBuilder<MicupBotAutomodResponse>(harness, f.owner.token).get(`${f.base}/automod`).execute();
	const defaults = await get();
	expect(defaults.rules).toHaveLength(6);
	expect(defaults.rules.every((r) => !r.enabled && r.action === 'delete_warn')).toBe(true);
	expect(defaults.rules.find((r) => r.rule === 'caps')?.threshold).toBe(70);
	await createBuilder(harness, f.owner.token)
		.put(`${f.base}/automod`)
		.body({rules: [{rule: 'words', enabled: true, threshold: 0, words: ['example']}]})
		.execute();
	expect((await get()).rules.find((r) => r.rule === 'words')?.words).toEqual(['example']);
	await createBuilder(harness, f.owner.token).put(`${f.base}/automod`).body({rules: []}).execute();
	expect(await get()).toEqual(defaults);
	expect(await f.repository.listRules(f.guildId)).toEqual([]);
});

it('official_apps lists each configured bot only while its own feature is live', async () => {
	const originalRosterId = Config.instance.rosterBotApplicationId;
	try {
		Config.instance.rosterBotApplicationId = '1490000000000000002';
		const get = () => createBuilder<WellKnownFluxerResponse>(harness, '').get('/.well-known/fluxer').execute();
		for (const [micupbot, roster] of [
			[0, 1],
			[1, 0],
			[0, 0],
			[1, 1],
		]) {
			overrideLimits({feature_micupbot: micupbot, feature_guild_roster: roster});
			const expected = [
				...(micupbot ? [Config.instance.micupBotApplicationId] : []),
				...(roster ? [Config.instance.rosterBotApplicationId] : []),
			];
			expect((await get()).features.official_apps.map((app) => app.application_id)).toEqual(expected);
		}
	} finally {
		Config.instance.rosterBotApplicationId = originalRosterId;
	}
});
