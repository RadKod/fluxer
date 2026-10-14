// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createRoleID, createUserID} from '@app/api/BrandedTypes';
import {authorizeBot} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import {createRole, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import type {MicupBotGuildSettingsRow} from '@app/api/database/types/MicupBotTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_BOT_INVITE_PERMISSIONS} from '@app/api/guild/micupbot/MicupBotConstants';
import {
	createMicupBotMemberEventRunner,
	type MicupBotMemberEventPayload,
} from '@app/api/guild/micupbot/MicupBotMemberEvents';
import {invalidateMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {updateRolePositions} from '@app/api/guild/tests/GuildTestUtils';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {ServiceMiddleware} from '@app/api/middleware/ServiceMiddleware';
import {getGatewayService, getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getCacheService,
	getChannelRepository,
	getGuildRepository,
	getLimitConfigService,
	getMicupBotRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {Hono} from 'hono';
import {afterAll, afterEach, beforeAll, beforeEach, vi} from 'vitest';

export function useMemberFixture() {
	let harness: ApiTestHarness;
	let previousId: string | undefined;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		previousId = Config.instance.micupBotApplicationId;
		Config.instance.micupBotApplicationId = undefined;
		await harness.reset();
	});
	afterEach(() => {
		Config.instance.micupBotApplicationId = previousId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	return async (patch: Partial<MicupBotGuildSettingsRow> = {}) => createMemberFixture(harness, patch);
}

async function createMemberFixture(harness: ApiTestHarness, patch: Partial<MicupBotGuildSettingsRow>) {
	const setup = await setupTestGuildWithMembers(harness, 1);
	const application = await createOAuth2Application(harness, setup.owner.token, {name: 'Member events'});
	await authorizeBot(
		harness,
		setup.owner.token,
		application.application.id,
		['bot'],
		setup.guild.id,
		MICUPBOT_BOT_INVITE_PERMISSIONS.toString(),
	);
	const guildId = createGuildID(BigInt(setup.guild.id));
	const userId = createUserID(BigInt(setup.members[0]!.userId));
	const botId = createUserID(BigInt(application.botUserId));
	const channelId = createChannelID(BigInt(setup.systemChannel.id));
	const guildRepository = getGuildRepository();
	const botMember = (await guildRepository.getMember(guildId, botId))!;
	const botRole = [...botMember.roleIds][0]!;
	const roles = [];
	for (const name of ['Blue', 'Green']) {
		const role = await createRole(harness, setup.owner.token, setup.guild.id, {name, permissions: '0'});
		roles.push(createRoleID(BigInt(role.id)));
	}
	await updateRolePositions(harness, setup.owner.token, setup.guild.id, [{id: botRole.toString(), position: 4}]);
	const app = new Hono<HonoEnv>();
	let guildService!: WorkerDependencies['guildService'];
	let channelService!: WorkerDependencies['channelService'];
	app.use(ServiceMiddleware);
	app.get('/', (ctx) => {
		guildService = ctx.get('guildService');
		channelService = ctx.get('channelService');
		return ctx.body(null, 204);
	});
	await app.request('/');
	const deps = {
		guildService,
		channelService,
		guildRepository,
		kvClient: getKVClient(),
		workerService: getWorkerService(),
		channelRepository: getChannelRepository(),
		userRepository: getUserRepository(),
		limitConfigService: getLimitConfigService(),
		gatewayService: getGatewayService(),
		cacheService: getCacheService(),
	} as WorkerDependencies;
	const repository = getMicupBotRepository();
	let settings: MicupBotGuildSettingsRow = {
		guild_id: guildId,
		commands_enabled: false,
		levels_enabled: false,
		automod_enabled: false,
		welcome_enabled: true,
		welcome_channel_id: channelId,
		welcome_message: null,
		welcome_embed: false,
		goodbye_enabled: true,
		goodbye_channel_id: channelId,
		goodbye_message: null,
		goodbye_embed: false,
		autorole_ids: new Set([roles[0]!]),
		level_up_message_enabled: false,
		level_up_channel_id: null,
		level_up_message: null,
		no_xp_channel_ids: null,
		no_xp_role_ids: null,
		voice_xp_enabled: false,
		updated_by: createUserID(BigInt(setup.owner.userId)),
		updated_at: new Date(),
		version: 0,
		...patch,
	};
	await repository.putSettings(settings, null);
	await invalidateMicupBotGuildConfig(guildId);
	const initialGuild = (await guildRepository.findUnique(guildId))!;
	const guild = await guildRepository.upsert({
		...initialGuild.toRow(),
		features: new Set([...initialGuild.features, GuildFeatures.MICUPBOT_JOIN]),
	});
	Config.instance.micupBotApplicationId = application.application.id;
	overrideLimits({feature_micupbot: 1});
	const payload: MicupBotMemberEventPayload = {
		kind: 'join',
		guild_id: String(guildId),
		user_id: String(userId),
		temporary: false,
		at: Date.now(),
	};
	return {
		...setup,
		harness,
		deps,
		repository,
		guildId,
		userId,
		botId,
		botRole,
		channelId,
		roles,
		guildModel: guild,
		payload,
		user: (await deps.userRepository.findUnique(userId))!,
		runner: createMicupBotMemberEventRunner(deps),
		jobs: vi.spyOn(deps.workerService, 'addJob'),
		grant: vi.spyOn(guildService.members, 'addMemberRole'),
		revoke: vi.spyOn(guildService.members, 'removeMemberRole'),
		send: vi.spyOn(channelService.messages.send, 'sendMessage'),
		async settings(update: Partial<MicupBotGuildSettingsRow>) {
			settings = {...settings, ...update};
			const current = (await repository.getSettings(guildId))!;
			await repository.putSettings(settings, current.version);
			await invalidateMicupBotGuildConfig(guildId);
		},
		async rejoin(isTemporary = false) {
			await guildRepository.deleteMember(guildId, userId);
			return guildService.members.addUserToGuild({
				guildId,
				userId,
				isTemporary,
				sendJoinMessage: false,
				requestCache: createRequestCache(),
			});
		},
	};
}

export const drainMemberHooks = () => new Promise<void>((resolve) => setImmediate(resolve));
