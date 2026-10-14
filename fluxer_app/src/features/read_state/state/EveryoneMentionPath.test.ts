// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {Channel} from '@app/features/channel/models/Channel';
import {ChannelTypes, MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import {MessageNotifications} from '@fluxer/constants/src/NotificationConstants';
import type {Channel as WireChannel} from '@fluxer/schema/src/domains/channel/ChannelSchemas';
import type {Message as WireMessage} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const GUILD_ID = 'guild-1';
const CHANNEL_ID = '1485064866382176262';
const ACK_ID = '1547700000000000000';
const MESSAGE_ID = '1547743701495717888';
const channels = new Map<string, Channel>();
let guildDefaultNotifications: number = MessageNotifications.ALL_MESSAGES;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/channel/state/Channels', () => ({
	default: {
		getChannel: (id: string) => channels.get(id),
		getGuildChannels: () => Array.from(channels.values()),
		getPrivateChannels: () => [],
	},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({
	default: {
		getGuildIds: () => [GUILD_ID],
		getGuild: () => ({joinedAt: null, effectiveMessageNotifications: guildDefaultNotifications}),
	},
}));
vi.mock('@app/features/user/state/Users', () => ({default: {getCurrentUser: () => ({id: 'me'})}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => null}}));
vi.mock('@app/features/relationship/state/Relationships', () => ({default: {isBlocked: () => false}}));
vi.mock('@app/features/user/state/AdvancedSettings', () => ({default: {unreadBadgeCustomizationEnabled: false}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		static create() {
			return new this();
		}
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/platform/utils/DeferUntilModulesLoaded', () => ({deferUntilModulesLoaded: () => {}}));
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({
	default: {
		handleIncomingMessage: () => {},
		getMessages: () => ({
			forEachBuffered: () => {},
			hasNewestMessages: () => false,
			hasMoreBefore: true,
			length: 0,
		}),
	},
}));
vi.mock('@app/features/messaging/state/MessageReferences', () => ({default: {handleMessageCreate: () => {}}}));
vi.mock('@app/features/notification/state/MentionFeed', () => ({default: {handleMessageCreate: () => {}}}));
vi.mock('@app/features/typing/state/TypingIndicator', () => ({default: {stopTypingOnMessageCreate: () => {}}}));
vi.mock('@app/features/ui/state/Notification', () => ({default: {handleMessageCreate: () => {}}}));
vi.mock('@app/features/voice/state/CallState', () => ({default: {}}));
vi.mock('@app/features/voice/utils/VoiceTtsUtils', () => ({default: {handleIncomingTtsMessage: () => {}}}));
vi.mock('@app/features/ui/state/Dimension', () => ({default: {channelPinnedToEnd: () => false}}));
vi.mock('@app/features/notification/state/NotificationAutoAck', () => ({
	default: {isAutomaticAckEnabled: () => false, disableForChannel: () => {}},
}));
// These fixtures deliver plain guild/DM messages; thread and forum navigation is outside this path.
vi.mock('@app/features/threads/state/ChannelThreads', () => ({
	default: {getGuildThreadIds: () => [], getGuildThreads: () => [], getThread: () => undefined},
}));
vi.mock('@app/features/forum/state/ForumReadState', () => ({hasForumUnread: () => false}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({http: {post: vi.fn(), get: vi.fn()}}));

const {default: ReadStates} = await import('@app/features/read_state/state/ReadStates');
const {default: UserGuildSettings} = await import('@app/features/user/state/UserGuildSettings');
const {default: GuildReadState} = await import('@app/features/guild/state/GuildReadState');
const {handleMessageCreate} = await import('@app/features/messaging/events/MessageCreate');

function message(mentionEveryone = true): WireMessage {
	return {
		id: MESSAGE_ID,
		channel_id: CHANNEL_ID,
		guild_id: GUILD_ID,
		author: {
			id: 'sender',
			username: 'sender',
			discriminator: '0',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		type: MessageTypes.DEFAULT,
		flags: 0,
		pinned: false,
		tts: false,
		mention_everyone: mentionEveryone,
		content: '@everyone',
		timestamp: '2026-09-11T00:00:00.000Z',
		mentions: [],
		mention_roles: [],
	} as WireMessage;
}

function deliver(mentionEveryone = true): void {
	handleMessageCreate(message(mentionEveryone), {} as Parameters<typeof handleMessageCreate>[1]);
}

function messageId(offset: number): string {
	return (BigInt(MESSAGE_ID) + BigInt(offset)).toString();
}

function deliverMessage(id: string, channelId = CHANNEL_ID, mentionEveryone = true): void {
	handleMessageCreate(
		{...message(mentionEveryone), id, channel_id: channelId, guild_id: channels.get(channelId)?.guildId},
		{} as Parameters<typeof handleMessageCreate>[1],
	);
}

function addChannel(id: string, type: number = ChannelTypes.GUILD_TEXT): WireChannel {
	const channel: WireChannel = {
		id,
		type,
		...(type === ChannelTypes.GUILD_TEXT ? {guild_id: GUILD_ID} : {}),
		last_message_id: ACK_ID,
	};
	channels.set(id, new Channel(channel));
	ReadStates.handleChannelCreate({channel});
	return channel;
}

function expectCounts(mentionCount: number): void {
	expect(ReadStates.hasUnread(CHANNEL_ID)).toBe(true);
	expect(ReadStates.getUnreadCount(CHANNEL_ID)).toBe(1);
	expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(mentionCount);
	expect(GuildReadState.mentionCountForGuild(GUILD_ID)).toBe(mentionCount);
}

beforeEach(() => {
	vi.useFakeTimers();
	guildDefaultNotifications = MessageNotifications.ALL_MESSAGES;
	channels.clear();
	const channel: WireChannel = {
		id: CHANNEL_ID,
		type: ChannelTypes.GUILD_TEXT,
		guild_id: GUILD_ID,
		last_message_id: ACK_ID,
	};
	channels.set(CHANNEL_ID, new Channel(channel));
	UserGuildSettings.handleGatewayReady([{guild_id: GUILD_ID, message_notifications: MessageNotifications.INHERIT}]);
	ReadStates.handleGatewayReady({
		readState: [{id: CHANNEL_ID, last_message_id: ACK_ID, mention_count: 0, version: '1'}],
		channels: [channel],
	});
	GuildReadState.handleGatewayReady();
});

afterEach(() => {
	ReadStates.clearAll();
	UserGuildSettings.handleGatewayReady([]);
	channels.clear();
	GuildReadState.handleGatewayReady();
	vi.useRealTimers();
});

describe('MESSAGE_CREATE everyone mention path', () => {
	it('increments both channel and guild mention counts for an unread authorized everyone mention', () => {
		deliver();
		expectCounts(1);
		expect(ReadStates.mentionChannelIds).toContain(CHANNEL_ID);
	});

	it('deduplicates a repeated MESSAGE_CREATE already covered by the channel watermark', () => {
		deliver();
		expectCounts(1);
		deliver();
		expectCounts(1);
		expect(ReadStates.mentionChannelIds).toContain(CHANNEL_ID);
	});

	it('counts a first everyone mention after a passive update advanced the channel watermark', () => {
		ReadStates.handlePassiveLastMessageUpdates({[CHANNEL_ID]: MESSAGE_ID}, GUILD_ID);
		deliver();
		expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(1);
		expect(GuildReadState.mentionCountForGuild(GUILD_ID)).toBe(1);
	});

	it('deduplicates an older MESSAGE_CREATE after another message was processed', () => {
		deliver();
		deliverMessage(messageId(1));
		deliver();
		expect(ReadStates.getUnreadCount(CHANNEL_ID)).toBe(2);
		expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(2);
		expect(GuildReadState.mentionCountForGuild(GUILD_ID)).toBe(2);
	});

	it('records suppressed deliveries before settings change', () => {
		UserGuildSettings.updateGuildSettings(GUILD_ID, {suppress_everyone: true});
		deliver();
		UserGuildSettings.updateGuildSettings(GUILD_ID, {suppress_everyone: false});
		deliver();
		expectCounts(0);
	});

	it('records deliveries without mentions before a repeated delivery gains a mention', () => {
		deliver(false);
		deliver();
		expectCounts(0);
	});

	it('evicts the oldest processed ID after more than 1000 messages', () => {
		for (let offset = 0; offset <= 1000; offset++) {
			deliverMessage(messageId(offset));
		}
		expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(1001);
		deliver();
		expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(1002);
		expect(ReadStates.getUnreadCount(CHANNEL_ID)).toBe(1001);
	});

	it('refreshes a repeated ID in the LRU while evicting the next oldest ID', () => {
		for (let offset = 0; offset < 1000; offset++) {
			deliverMessage(messageId(offset));
		}
		deliver();
		expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(1000);
		deliverMessage(messageId(1000));
		deliver();
		expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(1001);
		deliverMessage(messageId(1));
		expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(1002);
		expect(ReadStates.getUnreadCount(CHANNEL_ID)).toBe(1001);
	});

	it.each(['local', 'bulk', 'sticky', 'server', 'refresh', 'manual'] as const)(
		'frees acknowledged IDs for a %s ack without evicting another channel',
		(kind) => {
			const retainedChannelId = '1485064866382176263';
			addChannel(retainedChannelId);
			if (kind === 'refresh') {
				ReadStates.handleMessageAck({channelId: CHANNEL_ID, messageId: messageId(999), manual: false});
			}
			deliverMessage(MESSAGE_ID, retainedChannelId);
			for (let offset = 1; offset <= 999; offset++) {
				deliverMessage(messageId(offset));
			}
			switch (kind) {
				case 'local':
					ReadStates.handleChannelAck({channelId: CHANNEL_ID});
					break;
				case 'bulk':
					ReadStates.handleBulkChannelAck([{channelId: CHANNEL_ID, messageId: messageId(999)}]);
					break;
				case 'sticky':
					ReadStates.get(CHANNEL_ID).messagesLoaded = true;
					ReadStates.handleChannelAckWithStickyUnread({channelId: CHANNEL_ID});
					break;
				default:
					ReadStates.handleMessageAck({
						channelId: CHANNEL_ID,
						messageId: messageId(999),
						mentionCount: 0,
						manual: kind === 'manual',
					});
			}
			for (let offset = 1000; offset <= 1998; offset++) {
				deliverMessage(messageId(offset));
			}
			deliverMessage(MESSAGE_ID, retainedChannelId);
			expect(ReadStates.getMentionCount(retainedChannelId)).toBe(1);
		},
	);

	it.each(['local', 'advance', 'refresh', 'manual', 'stale', 'older', 'ignoredLocal'] as const)(
		'keeps processed unread IDs after a %s ack',
		(kind) => {
			deliver();
			if (kind === 'local' || kind === 'ignoredLocal') {
				ReadStates.handleChannelAck({
					channelId: CHANNEL_ID,
					messageId: kind === 'local' ? messageId(-1) : '1547699999999999999',
				});
			} else {
				ReadStates.handleMessageAck({
					channelId: CHANNEL_ID,
					messageId: kind === 'advance' ? messageId(-1) : kind === 'older' ? '1547699999999999999' : ACK_ID,
					mentionCount: kind === 'advance' ? 0 : 1,
					manual: kind === 'manual',
					version: kind === 'stale' ? '0' : '2',
				});
			}
			if (kind === 'advance' || kind === 'local') {
				expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(0);
			} else {
				expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(1);
			}
			const count = ReadStates.getMentionCount(CHANNEL_ID);
			deliver();
			expect(ReadStates.getMentionCount(CHANNEL_ID)).toBe(count);
		},
	);

	it.each([ChannelTypes.GUILD_TEXT, ChannelTypes.DM, ChannelTypes.GROUP_DM, ChannelTypes.DM_PERSONAL_NOTES])(
		'frees processed IDs when deleting channel type %s',
		(type) => {
			const retainedChannelId = '1485064866382176263';
			addChannel(retainedChannelId);
			addChannel(CHANNEL_ID, type);
			deliverMessage(MESSAGE_ID, retainedChannelId);
			for (let offset = 1; offset <= 999; offset++) {
				deliverMessage(messageId(offset));
			}
			ReadStates.handleChannelDelete({channel: {id: CHANNEL_ID, type, guild_id: channels.get(CHANNEL_ID)?.guildId}});
			addChannel(CHANNEL_ID, type);
			for (let offset = 1000; offset <= 1998; offset++) {
				deliverMessage(messageId(offset));
			}
			deliverMessage(MESSAGE_ID, retainedChannelId);
			expect(ReadStates.getMentionCount(retainedChannelId)).toBe(1);
		},
	);

	it.each(['clear', 'clearAll', 'ready'] as const)('forgets processed IDs after %s', (kind) => {
		deliver();
		if (kind === 'clear') {
			ReadStates.clear(CHANNEL_ID);
		} else if (kind === 'clearAll') {
			ReadStates.clearAll();
		} else {
			ReadStates.handleGatewayReady({
				readState: [{id: CHANNEL_ID, last_message_id: ACK_ID, mention_count: 0}],
				channels: [{id: CHANNEL_ID, type: ChannelTypes.GUILD_TEXT, guild_id: GUILD_ID, last_message_id: ACK_ID}],
			});
		}
		deliver();
		expectCounts(1);
	});

	it('keeps unread state but adds no mention when suppress_everyone is enabled', () => {
		UserGuildSettings.updateGuildSettings(GUILD_ID, {suppress_everyone: true});
		deliver();
		expectCounts(0);
		expect(ReadStates.mentionChannelIds).not.toContain(CHANNEL_ID);
	});

	it('does not infer an everyone mention from content when the server sends mention_everyone false', () => {
		deliver(false);
		expectCounts(0);
	});

	it.each([MessageNotifications.ALL_MESSAGES, MessageNotifications.ONLY_MENTIONS, MessageNotifications.NO_MESSAGES])(
		'preserves explicit mention counts with inherited guild notification level %s',
		(level) => {
			guildDefaultNotifications = level;
			expect(UserGuildSettings.getGuildMessageNotifications(GUILD_ID)).toBe(level);
			deliver();
			expectCounts(1);
			expect(GuildReadState.guildIsUnread(GUILD_ID)).toBe(level !== MessageNotifications.NO_MESSAGES);
		},
	);

	it('preserves an explicit everyone mention in a muted channel while hiding the guild unread indicator', () => {
		UserGuildSettings.updateChannelOverride(GUILD_ID, CHANNEL_ID, {muted: true});
		deliver();
		expectCounts(1);
		expect(GuildReadState.guildIsUnread(GUILD_ID)).toBe(false);
	});
});
