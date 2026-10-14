// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {authorizeBot} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import type {MicupBotAutomodRuleRow, MicupBotGuildSettingsRow} from '@app/api/database/types/MicupBotTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_BOT_INVITE_PERMISSIONS} from '@app/api/guild/micupbot/MicupBotConstants';
import type {notifyMicupBotMessage} from '@app/api/guild/micupbot/MicupBotMessageHook';
import * as Logging from '@app/api/Logger';
import {ensureSessionStarted} from '@app/api/message/tests/MessageTestUtils';
import {ServiceMiddleware} from '@app/api/middleware/ServiceMiddleware';
import {getGatewayService, getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getGuildRepository, getLimitConfigService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {Hono} from 'hono';
import {vi} from 'vitest';

export const GUILD_ID = createGuildID(810000000000000001n);
export const CHANNEL_ID = createChannelID(810000000000000002n);
export const USER_ID = createUserID(810000000000000003n);
export const NOW = Date.parse('2026-10-02T12:00:00Z');

export function captureHookWarnings() {
	const logger = new NoopLogger();
	vi.spyOn(Logging, 'Logger', 'get').mockReturnValue(logger);
	return vi.spyOn(logger, 'warn');
}

export function settings(overrides: Partial<MicupBotGuildSettingsRow> = {}): MicupBotGuildSettingsRow {
	return {
		guild_id: GUILD_ID,
		commands_enabled: true,
		levels_enabled: true,
		automod_enabled: true,
		welcome_enabled: false,
		welcome_channel_id: null,
		welcome_message: null,
		welcome_embed: false,
		goodbye_enabled: false,
		goodbye_channel_id: null,
		goodbye_message: null,
		goodbye_embed: false,
		autorole_ids: null,
		level_up_message_enabled: true,
		level_up_channel_id: null,
		level_up_message: null,
		no_xp_channel_ids: null,
		no_xp_role_ids: null,
		voice_xp_enabled: false,
		updated_by: USER_ID,
		updated_at: new Date(NOW),
		version: 0,
		...overrides,
	};
}

export function rule(overrides: Partial<MicupBotAutomodRuleRow> = {}): MicupBotAutomodRuleRow {
	return {
		guild_id: GUILD_ID,
		rule: 'words',
		enabled: true,
		action: 'delete_warn',
		threshold: 5,
		mute_seconds: 600,
		words: new Set(['yasak']),
		allowed_domains: null,
		exempt_role_ids: null,
		exempt_channel_ids: null,
		updated_by: USER_ID,
		updated_at: new Date(NOW),
		...overrides,
	};
}

export type HookInput = Parameters<typeof notifyMicupBotMessage>[0];
export function hookInput(content = 'hello'): HookInput {
	// Unit calls supply the fields read by the hook; route tests exercise the complete models.
	return {
		guild: {
			id: GUILD_ID.toString(),
			features: [GuildFeatures.MICUPBOT_COMMANDS, GuildFeatures.MICUPBOT_LEVELS, GuildFeatures.MICUPBOT_AUTOMOD],
			mfa_level: 0,
		},
		member: {roles: []},
		channel: {id: CHANNEL_ID},
		user: {id: USER_ID, isBot: false},
		message: {
			id: createMessageID(810000000000000004n),
			content,
			type: 0,
			webhookId: null,
			mentionedUserIds: new Set(),
			mentionedRoleIds: new Set(),
			mentionEveryone: false,
		},
	} as unknown as HookInput;
}

export async function drainHook(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function createHookFixture(harness: ApiTestHarness) {
	const setup = await setupTestGuildWithMembers(harness, 1);
	const app = await createOAuth2Application(harness, setup.owner.token, {name: 'Hook test bot'});
	await authorizeBot(
		harness,
		setup.owner.token,
		app.application.id,
		['bot'],
		setup.guild.id,
		MICUPBOT_BOT_INVITE_PERMISSIONS.toString(),
	);
	await ensureSessionStarted(harness, setup.members[0]!.token);
	Config.instance.micupBotApplicationId = app.application.id;
	overrideLimits({feature_micupbot: 1});
	const services = new Hono<HonoEnv>();
	let channelService!: WorkerDependencies['channelService'];
	let guildService!: WorkerDependencies['guildService'];
	services.use(ServiceMiddleware);
	services.get('/', (ctx) => {
		channelService = ctx.get('channelService');
		guildService = ctx.get('guildService');
		return ctx.body(null, 204);
	});
	await services.request('/');
	const deps = {
		channelService,
		guildService,
		kvClient: getKVClient(),
		gatewayService: getGatewayService(),
		workerService: getWorkerService(),
		userRepository: getUserRepository(),
		limitConfigService: getLimitConfigService(),
	} as WorkerDependencies;
	return {...setup, deps, botId: createUserID(BigInt(app.botUserId))};
}

export async function setHookFlags(guildId: string, features: Array<string>): Promise<void> {
	await getGuildRepository().upsertPartial(createGuildID(BigInt(guildId)), {features: new Set(features)});
}
