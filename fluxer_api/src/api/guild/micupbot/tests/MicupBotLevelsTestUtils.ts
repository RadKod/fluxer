// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createRoleID, createUserID, type GuildID} from '@app/api/BrandedTypes';
import {authorizeBot} from '@app/api/bot/tests/BotTestUtils';
import {Config} from '@app/api/Config';
import {createRole, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import type {MicupBotGuildSettingsRow} from '@app/api/database/types/MicupBotTypes';
import {overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {MICUPBOT_BOT_INVITE_PERMISSIONS} from '@app/api/guild/micupbot/MicupBotConstants';
import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {invalidateMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {updateRolePositions} from '@app/api/guild/tests/GuildTestUtils';
import {ServiceMiddleware} from '@app/api/middleware/ServiceMiddleware';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getGuildRepository,
	getKVCounterService,
	getLimitConfigService,
	getMicupBotRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {createOAuth2Application} from '@app/api/oauth/tests/OAuth2TestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {Hono} from 'hono';
import {vi} from 'vitest';

export const GUILD = createGuildID(20n << 22n);
export const USER = createUserID(3n << 22n);
export const CHANNEL = createChannelID(300n);

export function levelSettings(
	guildId: GuildID,
	patch: Partial<MicupBotGuildSettingsRow> = {},
): MicupBotGuildSettingsRow {
	return {
		guild_id: guildId,
		commands_enabled: false,
		levels_enabled: true,
		automod_enabled: false,
		welcome_enabled: false,
		welcome_channel_id: null,
		welcome_message: null,
		welcome_embed: false,
		goodbye_enabled: false,
		goodbye_channel_id: null,
		goodbye_message: null,
		goodbye_embed: false,
		autorole_ids: null,
		level_up_message_enabled: false,
		level_up_channel_id: null,
		level_up_message: null,
		no_xp_channel_ids: null,
		no_xp_role_ids: null,
		voice_xp_enabled: false,
		updated_by: USER,
		updated_at: new Date(),
		version: 0,
		...patch,
	};
}

export function levelsFixture() {
	const kvClient = getKVClient();
	const counterService = getKVCounterService();
	const repository = getMicupBotRepository();
	const workerService = getWorkerService();
	const levels = createMicupBotLevels({kvClient, counterService, repository, workerService: () => workerService});
	return {kvClient, counterService, repository, workerService, levels};
}

export function taskHelpers(): WorkerTaskHelpers {
	return {
		logger: new NoopLogger(),
		jobId: 1n,
		addJob: async () => 0n,
		reportProgress: async () => {},
		shouldCancel: async () => false,
		setContextLink: async () => {},
	};
}

export async function rewardFixture(harness: ApiTestHarness) {
	const setup = await setupTestGuildWithMembers(harness, 1);
	const application = await createOAuth2Application(harness, setup.owner.token, {name: 'Level rewards'});
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
	const rewards = [];
	for (const level of [1, 2, 3]) {
		const role = await createRole(harness, setup.owner.token, setup.guild.id, {
			name: `Level ${level}`,
			permissions: '0',
		});
		rewards.push({
			guild_id: guildId,
			level,
			role_id: createRoleID(BigInt(role.id)),
			updated_by: createUserID(BigInt(setup.owner.userId)),
			updated_at: new Date(),
		});
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
		kvClient: getKVClient(),
		workerService: getWorkerService(),
		guildRepository,
		guildService,
		channelService,
		limitConfigService: getLimitConfigService(),
		userRepository: getUserRepository(),
	} as WorkerDependencies;
	const repository = getMicupBotRepository();
	await repository.putSettings(levelSettings(guildId), null);
	await invalidateMicupBotGuildConfig(guildId);
	await repository.replaceRewards(guildId, rewards);
	Config.instance.micupBotApplicationId = application.application.id;
	overrideLimits({feature_micupbot: 1});
	return {
		...setup,
		deps,
		guildId,
		userId,
		botId,
		botRole,
		channelId,
		repository,
		rewards,
		levels: createMicupBotLevels(deps),
		payload: {
			guild_id: guildId.toString(),
			user_id: userId.toString(),
			channel_id: channelId.toString(),
			level: 2,
			at: Date.now(),
		},
		grant: vi.spyOn(guildService.members, 'addMemberRole'),
		send: vi.spyOn(channelService.messages.send, 'sendMessage'),
	};
}
