// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createMessageID, createUserID, userIdToChannelId} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {AuthenticatedChannel} from '@app/api/channel/services/AuthenticatedChannel';
import {GroupDmOperationsService} from '@app/api/channel/services/group_dm/GroupDmOperationsService';
import {MessageReactionService} from '@app/api/channel/services/interaction/MessageReactionService';
import {MessageCrosspostService} from '@app/api/channel/services/message/MessageCrosspostService';
import {MessageEditService} from '@app/api/channel/services/message/MessageEditService';
import {MessageRequestService} from '@app/api/channel/services/message/MessageRequestService';
import {MessageSendService} from '@app/api/channel/services/message/MessageSendService';
import {GuildOperationsService} from '@app/api/guild/services/data/GuildOperationsService';
import {GuildMemberOperationsService} from '@app/api/guild/services/member/GuildMemberOperationsService';
import {InviteService} from '@app/api/invite/InviteService';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import * as ServiceRegistry from '@app/api/middleware/ServiceRegistry';
import * as ServiceSingletons from '@app/api/middleware/ServiceSingletons';
import type {Channel} from '@app/api/models/Channel';
import type {User} from '@app/api/models/User';
import {InternalRpcController} from '@app/api/rpc/InternalRpcController';
import {RpcService} from '@app/api/rpc/RpcService';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {UsernameSelectionGate} from '@app/api/user/username/UsernameSelectionGate';
import {VoiceService} from '@app/api/voice/VoiceService';
import {ChannelTypes, InviteTypes, MessageReferenceTypes} from '@fluxer/constants/src/ChannelConstants';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {AppErrorHandler} from '@fluxer/errors/src/domains/core/ErrorHandlers';
import {Hono} from 'hono';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = {
	user: null as User | null,
	selection: null as 'selected' | 'reselect_required' | null,
	forced: true,
	gate: null as UsernameSelectionGate | null,
};

const USER = createUserID(100n);
const TARGET = createUserID(200n);
const CHANNEL = createChannelID(300n);
const GUILD = createGuildID(400n);
const MESSAGE = createMessageID(500n);
const NEXT = new Error('next existing validation');
const next = () => {
	throw NEXT;
};
const cache = {} as RequestCache;
const viewer = {kind: 'user' as const, userId: USER, bot: false, capable: true};

function subject<T extends object>(prototype: T, dependencies: object): T {
	return Object.assign(Object.create(prototype), dependencies);
}

function user(overrides: object = {}): User {
	return {
		id: USER,
		isBot: false,
		isSystem: false,
		flags: UserFlags.HAS_SESSION_STARTED,
		deletionStartedAt: null,
		tempBannedUntil: null,
		email: 'test@example.com',
		emailVerified: true,
		requiredActions: null,
		suspiciousActivityFlags: 0,
		traits: new Set(),
		isUnclaimedAccount: () => false,
		...overrides,
	} as unknown as User;
}

beforeEach(() => {
	state.user = user();
	state.selection = null;
	state.forced = true;
	state.gate = new UsernameSelectionGate(
		() => ({state: 'selecting', forcedAt: new Date(state.forced ? 0 : Date.now() + 86400000)}),
		() => state.selection,
	);
	vi.spyOn(ServiceRegistry, 'getUsernameSelectionGate').mockImplementation(() => state.gate!);
	vi.spyOn(ServiceSingletons, 'getUserRepository').mockReturnValue({
		findUnique: async () => state.user,
	} as unknown as ReturnType<typeof ServiceSingletons.getUserRepository>);
});

afterEach(() => vi.restoreAllMocks());

const auth: AuthenticatedChannel = {
	channel: {
		id: CHANNEL,
		type: ChannelTypes.GROUP_DM,
		recipientIds: new Set([USER]),
		isThread: () => false,
	} as unknown as Channel,
	guild: null,
	member: null,
	hasPermission: async () => true,
	checkPermission: async () => {},
};

function requestService(): MessageRequestService {
	return subject(MessageRequestService.prototype, {
		channelService: {
			messages: {send: {sendMessage: next, validateForumStarter: next}, crosspost: crosspost(), edit: edit()},
		},
	});
}

function sendService(): MessageSendService {
	return subject(MessageSendService.prototype, {
		deps: {channelAuthService: {getChannelAuthenticated: next}},
		checkMessageSendPermissions: next,
	});
}

function groups(): GroupDmOperationsService {
	return subject(GroupDmOperationsService.prototype, {
		channelRepository: {channelData: {findUnique: async () => auth.channel, upsert: next}},
		userRepository: {findUnique: async () => state.user, getRelationship: next},
		resolveLimitForUser: next,
	});
}

function voice(): VoiceService {
	return subject(VoiceService.prototype, {
		userRepository: {findUnique: async () => state.user},
		channelRepository: {findUnique: next},
	});
}

function crosspost(): MessageCrosspostService {
	return subject(MessageCrosspostService.prototype, {deps: {channelAuthService: {getChannelAuthenticated: next}}});
}

function edit(): MessageEditService {
	return subject(MessageEditService.prototype, {
		deps: {
			channelAuthService: {getChannelAuthenticated: async () => auth},
			channelRepository: {messages: {getMessage: async () => ({authorId: USER})}},
			userRepository: {findUnique: async () => state.user},
			validationService: {validateMessageEditable: next},
		},
	});
}

function reaction(): MessageReactionService {
	return subject(MessageReactionService.prototype, {
		ensureTextChannel: () => {},
		assertMessageHistoryAccess: async () => {},
		channelRepository: {messages: {getMessage: async () => ({id: MESSAGE})}},
		userRepository: {findUnique: async () => state.user},
		limitConfigService: {getConfigSnapshot: next},
	});
}

function invite(type: number): InviteService {
	return subject(InviteService.prototype, {
		findInviteWithLowercaseFallback: async () => ({type, channelId: CHANNEL, guildId: GUILD, maxUses: 0}),
		apiContext: {services: {users: {findUnique: async () => state.user}}},
		channelService: {channelData: {operations: {getChannelSystem: next}}},
		guildService: {data: {getGuildSystem: next}},
	});
}

function members(): GuildMemberOperationsService {
	return subject(GuildMemberOperationsService.prototype, {
		guildRepository: {findUnique: async () => ({}), getMember: async () => null, countUserGuilds: next},
		userRepository: {findUnique: async () => state.user},
		validationService: {checkUserBanStatus: next},
	});
}

const messageParams = () => ({user: state.user!, viewer, channelId: CHANNEL, data: {}, requestCache: cache});
const byIdParams = {userId: USER, viewer, channelId: CHANNEL, messageId: MESSAGE, data: {}, requestCache: cache};
const groupParams = {userId: USER, channelId: CHANNEL, recipientId: TARGET, botUserId: TARGET, requestCache: cache};

const actions: Array<[string, () => Promise<unknown>]> = [
	[
		'request send',
		() => requestService().sendMessage(messageParams() as Parameters<MessageRequestService['sendMessage']>[0]),
	],
	[
		'request crosspost',
		() => requestService().crosspostMessage(byIdParams as Parameters<MessageRequestService['crosspostMessage']>[0]),
	],
	[
		'request edit',
		() => requestService().editMessage(byIdParams as Parameters<MessageRequestService['editMessage']>[0]),
	],
	[
		'request forum validation',
		() =>
			requestService().validateForumStarter({...messageParams(), parentAuth: auth} as Parameters<
				MessageRequestService['validateForumStarter']
			>[0]),
	],
	[
		'request forum send',
		() =>
			requestService().sendForumStarter({...messageParams(), parentAuth: auth, threadId: CHANNEL} as Parameters<
				MessageRequestService['sendForumStarter']
			>[0]),
	],
	['send core', () => sendService().sendMessage(messageParams() as Parameters<MessageSendService['sendMessage']>[0])],
	[
		'personal notes send',
		() =>
			sendService().sendMessage({...messageParams(), channelId: userIdToChannelId(USER)} as Parameters<
				MessageSendService['sendMessage']
			>[0]),
	],
	[
		'forum send core',
		() =>
			sendService().sendMessage({...messageParams(), forumStarter: {parentAuth: auth}} as Parameters<
				MessageSendService['sendMessage']
			>[0]),
	],
	[
		'forward core',
		() =>
			sendService().sendMessage({
				...messageParams(),
				data: {message_reference: {type: MessageReferenceTypes.FORWARD, channel_id: CHANNEL, message_id: MESSAGE}},
			} as Parameters<MessageSendService['sendMessage']>[0]),
	],
	[
		'forum validation core',
		() =>
			sendService().validateForumStarter({...messageParams(), parentAuth: auth} as Parameters<
				MessageSendService['validateForumStarter']
			>[0]),
	],
	[
		'crosspost core',
		() => crosspost().crosspostMessage(byIdParams as Parameters<MessageCrosspostService['crosspostMessage']>[0]),
	],
	['edit core', () => edit().editMessage(byIdParams as Parameters<MessageEditService['editMessage']>[0])],
	[
		'reaction add',
		() =>
			reaction().addReaction({authChannel: auth, messageId: MESSAGE, emoji: '👍', userId: USER} as Parameters<
				MessageReactionService['addReaction']
			>[0]),
	],
	[
		'guild invite acceptance',
		() =>
			invite(InviteTypes.GUILD).acceptInvite({userId: USER, inviteCode: 'test', requestCache: cache} as Parameters<
				InviteService['acceptInvite']
			>[0]),
	],
	[
		'group invite acceptance',
		() =>
			invite(InviteTypes.GROUP_DM).acceptInvite({userId: USER, inviteCode: 'test', requestCache: cache} as Parameters<
				InviteService['acceptInvite']
			>[0]),
	],
	[
		'discovery guild join',
		() =>
			members().addUserToGuild(
				{userId: USER, guildId: GUILD, requestCache: cache} as Parameters<
					GuildMemberOperationsService['addUserToGuild']
				>[0],
				{} as Parameters<GuildMemberOperationsService['addUserToGuild']>[1],
			),
	],
	[
		'guild create',
		() =>
			subject(GuildOperationsService.prototype, {guildRepository: {countUserGuilds: next}}).createGuild({
				user: state.user!,
				data: {name: 'test'},
			} as Parameters<GuildOperationsService['createGuild']>[0]),
	],
	[
		'group recipient add',
		() =>
			groups().addRecipientToChannel(groupParams as Parameters<GroupDmOperationsService['addRecipientToChannel']>[0]),
	],
	[
		'group bot add by human',
		() =>
			groups().addBotRecipientToChannel(
				groupParams as Parameters<GroupDmOperationsService['addBotRecipientToChannel']>[0],
			),
	],
	[
		'group invite core',
		() =>
			groups().addRecipientViaInvite(groupParams as Parameters<GroupDmOperationsService['addRecipientViaInvite']>[0]),
	],
	['guild voice token', () => voice().getVoiceToken({userId: USER, channelId: CHANNEL, guildId: GUILD})],
	['dm voice token', () => voice().getVoiceToken({userId: USER, channelId: CHANNEL})],
	[
		'voice move token',
		() => voice().getVoiceToken({userId: USER, channelId: CHANNEL, guildId: GUILD, connectionId: 'existing'}),
	],
];

describe.each(actions)('Username selection: %s', (_name, act) => {
	it('rejects a forced unselected initiator before existing work', async () => {
		await expect(act()).rejects.toMatchObject({code: 'USERNAME_SELECTION_REQUIRED', status: 403});
	});
	it('rejects reselect independently of the global deadline', async () => {
		state.forced = false;
		state.selection = 'reselect_required';
		await expect(act()).rejects.toMatchObject({code: 'USERNAME_SELECTION_REQUIRED', status: 403});
	});
	it('keeps selected users on the existing validation path', async () => {
		state.selection = 'selected';
		await expect(act()).rejects.toBe(NEXT);
	});
	it('allows unselected humans before the forced deadline', async () => {
		state.forced = false;
		await expect(act()).rejects.toBe(NEXT);
	});
});

describe('Username selection actor and escape routes', () => {
	it('invite acceptance does not gate the historical inviter', async () => {
		state.gate = new UsernameSelectionGate(
			() => ({state: 'selecting', forcedAt: new Date(0)}),
			(actor) => (actor.id === USER ? 'reselect_required' : 'selected'),
		);
		const service = groups();
		Object.assign(service, {userRepository: {findUnique: async (id: bigint) => user({id})}});
		await expect(
			service.addRecipientViaInvite({...groupParams, inviterId: USER} as Parameters<
				GroupDmOperationsService['addRecipientViaInvite']
			>[0]),
		).rejects.toBe(NEXT);
	});
	it('message reading remains available to an unselected user', async () => {
		const service = subject(MessageRequestService.prototype, {
			channelService: {
				messages: {
					retrieval: {
						getResponseAccess: async () => ({
							access: {},
							authChannel: {channel: {guildId: null, isThreadOnly: () => false}},
						}),
						threadResponses: {shape: async () => []},
					},
				},
			},
			responseDataService: {listMessages: async () => []},
		});
		await expect(
			service.listMessages({...byIdParams, query: {limit: 50}} as Parameters<MessageRequestService['listMessages']>[0]),
		).resolves.toEqual([]);
	});
	it.each([
		{isBot: true},
		{isSystem: true},
		{flags: UserFlags.DELETED},
		{flags: UserFlags.DISABLED, tempBannedUntil: null},
		{flags: UserFlags.DISABLED, tempBannedUntil: new Date(Date.now() + 86400000)},
	])('voice exempts closed, suspended and nonhuman actors: $isBot $isSystem $flags', async (overrides) => {
		state.user = user(overrides);
		await expect(voice().getVoiceToken({userId: USER, channelId: CHANNEL})).rejects.toBe(NEXT);
	});
	it.each([{isBot: true}, {isSystem: true}])(
		'message send preserves nonhuman actors: $isBot $isSystem',
		async (overrides) => {
			state.user = user(overrides);
			await expect(
				sendService().sendMessage(messageParams() as Parameters<MessageSendService['sendMessage']>[0]),
			).rejects.toBe(NEXT);
		},
	);
	it('direct group addition gates the initiator rather than the target', async () => {
		state.gate = new UsernameSelectionGate(
			() => ({state: 'selecting', forcedAt: new Date(0)}),
			(actor) => (actor.id === USER ? 'selected' : null),
		);
		await expect(
			groups().addRecipientToChannel(groupParams as Parameters<GroupDmOperationsService['addRecipientToChannel']>[0]),
		).rejects.toBe(NEXT);
	});
	it('guild bot addition gates the human initiator', async () => {
		const service = members();
		Object.assign(service, {
			userRepository: {findUnique: async (id: bigint) => (id === USER ? state.user : user({id: TARGET, isBot: true}))},
		});
		await expect(
			service.addUserToGuild(
				{userId: TARGET, initiatorId: USER, guildId: GUILD, requestCache: cache} as Parameters<
					GuildMemberOperationsService['addUserToGuild']
				>[0],
				{} as Parameters<GuildMemberOperationsService['addUserToGuild']>[1],
			),
		).rejects.toMatchObject({code: 'USERNAME_SELECTION_REQUIRED'});
	});
	it('RPC transports the voice selection error unchanged', async () => {
		const service = subject(RpcService.prototype, {voiceService: voice()});
		await expect(
			service.handleRpcRequest({
				request: {type: 'voice_get_token', user_id: USER, channel_id: CHANNEL, guild_id: GUILD},
				requestCache: cache,
			} as Parameters<RpcService['handleRpcRequest']>[0]),
		).rejects.toMatchObject({code: 'USERNAME_SELECTION_REQUIRED', status: 403});
	});
	it.each([false, true])('internal RPC HTTP preserves voice selection code (guild=%s)', async (guild) => {
		const app = new Hono<HonoEnv>();
		app.use('*', async (ctx, nextMiddleware) => {
			ctx.set('rpcService', subject(RpcService.prototype, {voiceService: voice()}));
			ctx.set('requestCache', cache as HonoEnv['Variables']['requestCache']);
			await nextMiddleware();
		});
		app.onError(AppErrorHandler);
		InternalRpcController(app);
		const response = await app.request('/internal/rpc', {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-fluxer-rpc-auth': Config.internal.gatewayRpcAuthToken},
			body: JSON.stringify({
				type: 'voice_get_token',
				user_id: USER.toString(),
				channel_id: CHANNEL.toString(),
				...(guild ? {guild_id: GUILD.toString()} : {}),
			}),
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({code: 'USERNAME_SELECTION_REQUIRED'});
	});
	it('voice disconnect remains available', async () => {
		const service = subject(VoiceService.prototype, {voiceRoomStore: {getPinnedRoomServer: async () => null}});
		await expect(
			service.disconnectParticipant({userId: USER, channelId: CHANNEL, connectionId: 'existing'}),
		).resolves.toBeUndefined();
	});
	it('guild leaving reaches its existing access check', async () => {
		const service = subject(GuildMemberOperationsService.prototype, {gatewayService: {getGuildData: next}});
		await expect(service.leaveGuild({userId: USER, guildId: GUILD})).rejects.toBe(NEXT);
	});
	it('group recipient removal reaches its existing access check', async () => {
		const service = subject(GroupDmOperationsService.prototype, {channelRepository: {channelData: {findUnique: next}}});
		await expect(
			service.removeRecipientFromChannel(
				groupParams as Parameters<GroupDmOperationsService['removeRecipientFromChannel']>[0],
			),
		).rejects.toBe(NEXT);
	});
	it('reaction removal reaches its existing access check', async () => {
		const service = subject(MessageReactionService.prototype, {ensureTextChannel: next});
		await expect(
			service.removeReaction({
				authChannel: auth,
				messageId: MESSAGE,
				emoji: '👍',
				actorId: USER,
				targetId: USER,
			} as Parameters<MessageReactionService['removeReaction']>[0]),
		).rejects.toBe(NEXT);
	});
	it('webhook send reaches its existing validation without loading a human', async () => {
		const service = subject(MessageSendService.prototype, {
			deps: {channelRepository: {channelData: {findUnique: next}}},
		});
		await expect(
			service.sendWebhookMessage({webhook: {}, data: {}, requestCache: cache} as Parameters<
				MessageSendService['sendWebhookMessage']
			>[0]),
		).rejects.toBe(NEXT);
	});
});
