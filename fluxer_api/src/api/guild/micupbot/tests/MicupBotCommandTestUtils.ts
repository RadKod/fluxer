// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createMessageID, createRoleID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createMicupBotCommandRunner, type MicupBotCommandPayload} from '@app/api/guild/micupbot/MicupBotCommands';
import {createMicupBotFixture} from '@app/api/guild/micupbot/tests/MicupBotTestUtils';
import {updateRolePositions} from '@app/api/guild/tests/GuildTestUtils';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {ServiceMiddleware} from '@app/api/middleware/ServiceMiddleware';
import {getGatewayService, getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	createUserCacheService,
	getChannelRepository,
	getGuildRepository,
	getLimitConfigService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {Hono} from 'hono';
import {afterAll, afterEach, beforeAll, beforeEach, vi} from 'vitest';

export const MODERATION_PERMISSIONS =
	Permissions.BAN_MEMBERS |
	Permissions.KICK_MEMBERS |
	Permissions.MODERATE_MEMBERS |
	Permissions.MANAGE_ROLES |
	Permissions.MANAGE_MESSAGES |
	Permissions.MANAGE_CHANNELS |
	Permissions.MANAGE_NICKNAMES |
	Permissions.MOVE_MEMBERS;

export function useCommandFixture() {
	let harness: ApiTestHarness;
	let originalId: string | undefined;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		originalId = Config.instance.micupBotApplicationId;
		await harness.reset();
	});
	afterEach(() => {
		Config.instance.micupBotApplicationId = originalId;
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	return (permissions = MODERATION_PERMISSIONS) => commandFixture(harness, permissions);
}

async function commandFixture(harness: ApiTestHarness, permissions: bigint) {
	const base = await createMicupBotFixture(harness);
	const author = await base.member(permissions);
	const target = await base.member();
	const bot = await base.addBot();
	await updateRolePositions(harness, base.owner.token, base.guild.id, [
		{id: target.role.id, position: 1},
		{id: author.role.id, position: 3},
		{id: bot.botRoleId, position: 5},
	]);
	const app = new Hono<HonoEnv>();
	let channelService!: WorkerDependencies['channelService'];
	let guildService!: WorkerDependencies['guildService'];
	app.use(ServiceMiddleware);
	app.get('/', (ctx) => {
		channelService = ctx.get('channelService');
		guildService = ctx.get('guildService');
		return ctx.body(null, 204);
	});
	await app.request('/');
	const deps = {
		channelService,
		guildService,
		guildRepository: getGuildRepository(),
		channelRepository: getChannelRepository(),
		userRepository: getUserRepository(),
		userCacheService: createUserCacheService(),
		kvClient: getKVClient(),
		workerService: getWorkerService(),
		gatewayService: getGatewayService(),
		limitConfigService: getLimitConfigService(),
	} as WorkerDependencies;
	const guild = (await deps.guildRepository.findUnique(base.guildId))!;
	await deps.guildRepository.upsertPartial(guild.id, {
		features: new Set([...guild.features, GuildFeatures.MICUPBOT_COMMANDS]),
	});
	const send = vi.spyOn(channelService.messages.send, 'sendMessage');
	const runner = createMicupBotCommandRunner(deps);
	async function message(content: string, account: TestAccount = author) {
		const user = (await deps.userRepository.findUnique(createUserID(BigInt(account.userId))))!;
		const result = await channelService.messages.send.sendMessage({
			viewer: {kind: 'user', userId: user.id, bot: user.isBot, capable: user.isBot},
			user,
			channelId: base.channelId,
			data: {content},
			requestCache: createRequestCache(),
		});
		return result.message;
	}
	async function command(content: string, account: TestAccount = author): Promise<MicupBotCommandPayload> {
		const sent = await message(content, account);
		send.mockClear();
		return {
			guild_id: base.guild.id,
			channel_id: String(base.channelId),
			message_id: String(sent.id),
			author_id: account.userId,
			content,
			at: Date.now(),
		};
	}
	return {
		...base,
		harness,
		deps,
		author,
		target,
		bot,
		runner,
		send,
		message,
		command,
		targetId: createUserID(BigInt(target.userId)),
		authorId: createUserID(BigInt(author.userId)),
		botId: createUserID(BigInt(bot.botUserId)),
		async run(content: string, account: TestAccount = author) {
			const payload = await command(content, account);
			await runner.run(payload);
			return payload;
		},
		reply: () => send.mock.calls.at(-1)?.[0].data,
		async overwrite(allow: bigint, deny: bigint, id = base.guild.id, type = 0) {
			const channel = (await deps.channelRepository.channelData.findUnique(base.channelId))!;
			await deps.channelRepository.channelData.upsert({
				...channel.toRow(),
				permission_overwrites: new Map(
					[...channel.permissionOverwrites].map(([key, value]) => [key, value.toPermissionOverwrite()]),
				).set(createRoleID(BigInt(id)), {type, allow_: allow, deny_: deny}),
			});
		},
		async exists(messageId: string) {
			return deps.channelRepository.messages.getMessage(base.channelId, createMessageID(BigInt(messageId)));
		},
	};
}
