// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import {PublicUserFlags, RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import type {Message as WireMessage} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {act, createElement, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

// Keep the search machine, detached records, relationship event/store, grouping,
// and collapsed-group UI real. Isolate account services and message-row rendering.
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/channel/models/Channel', () => ({Channel: class {}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => undefined}}));
vi.mock('@app/features/navigation/state/SelectedGuild', () => ({default: {}}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {}}));
vi.mock('@app/features/user/state/SyncedField', () => ({makeSyncedField: vi.fn()}));
vi.mock('@app/features/user/state/Users', () => ({default: {cacheUsers: vi.fn(), getUser: () => undefined}}));
vi.mock('@app/features/user/models/User', () => ({
	User: class {
		readonly id: string;
		constructor(private readonly data: WireMessage['author']) {
			this.id = data.id;
		}
		toJSON() {
			return this.data;
		}
		get flags() {
			return this.data.flags;
		}
	},
}));
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({default: {handleRelationshipUpdate: vi.fn()}}));
vi.mock('@app/features/member/state/MemberSearch', () => ({default: {handleFriendshipChange: vi.fn()}}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {handleRelationshipUpdate: vi.fn()}}));
vi.mock('@app/features/search/state/QuickSwitcher', () => ({default: {recomputeIfOpen: vi.fn()}}));
vi.mock('@app/features/ui/state/Notification', () => ({default: {handleRelationshipNotification: vi.fn()}}));
vi.mock('@app/features/ui/state/KeyboardMode', () => ({default: {keyboardModeEnabled: false}}));
vi.mock('@app/features/messaging/utils/ReactionUtils', () => ({
	getReactionKey: (id: string, emoji: {name: string}) => `${id}:${emoji.name}:`,
}));
vi.mock('@app/features/messaging/utils/EmbeddableCodeLinkContent', () => ({
	extractEmbeddableCodeLinkContent: (content: string) => content,
}));
vi.mock('@app/features/gift/utils/GiftCodeUtils', () => ({findGifts: () => []}));
vi.mock('@app/features/invite/utils/InviteUtils', () => ({findInvites: () => []}));
vi.mock('@app/features/theme/utils/ThemeUtils', () => ({findThemes: () => []}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/channel/components/ChannelDivider', () => ({Divider: () => null}));
vi.mock('@app/features/channel/components/MessageGroup', () => ({
	MessageGroup: ({messages}: {messages: Array<{content: string}>}) =>
		messages.map((message) => message.content).join(' '),
}));

const {default: ChannelSearch} = await import('@app/features/channel/state/ChannelSearch');
const {Message} = await import('@app/features/messaging/models/MessagingMessage');
const {default: Relationships} = await import('@app/features/relationship/state/Relationships');
const {default: LocalUserSpamOverride} = await import('@app/features/moderation/state/LocalUserSpamOverride');
const {handleRelationshipAdd} = await import('@app/features/relationship/events/RelationshipAdd');
const {handleRelationshipRemove} = await import('@app/features/relationship/events/RelationshipRemove');
const {getCollapsedGroupType} = await import('@app/features/messaging/utils/MessageGroupingUtils');
const {SearchResultMessageList} = await import('@app/features/channel/components/SearchResultMessageList');

const gatewayContext = {} as import('@app/features/gateway/events/EventRouter').GatewayHandlerContext;
const channel = {id: 'search-channel'} as Channel;
const authorId = '1300000000000000001';
const wire = (id: string, flags = 0): WireMessage => ({
	id,
	channel_id: channel.id,
	author: {
		id: authorId,
		username: 'test',
		discriminator: '0000',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags,
	},
	type: 0,
	flags: 0,
	pinned: false,
	tts: false,
	mention_everyone: false,
	mentions: [],
	mention_roles: [],
	content: `private search content ${id}`,
	timestamp: '2026-10-03T12:00:00.000Z',
});
const block = () => handleRelationshipAdd({id: authorId, type: RelationshipTypes.BLOCKED}, gatewayContext);
const unblock = () => handleRelationshipRemove({id: authorId}, gatewayContext);
const searchResult = (id: string, flags = 0) => {
	const original = new Message(wire(id, flags));
	ChannelSearch.sendMachineEvent(
		id,
		{type: 'channelSearch.succeeded', results: [original], channels: [], total: 1, hitsPerPage: 25, page: 1},
		'query',
		[],
		null,
	);
	const state = ChannelSearch.getContext(id).machineState;
	expect(state.status).toBe('success');
	if (state.status !== 'success') throw new Error('Search did not succeed');
	expect(state.results[0]).not.toBe(original);
	return state.results;
};

afterEach(() => {
	Relationships.loadRelationships([]);
	LocalUserSpamOverride.clearAllOverrides();
});

describe('detached search result blocking', () => {
	it.each(['block', 'unblock'] as const)('groups an existing search copy after live %s', (operation) => {
		if (operation === 'unblock') block();
		const [message] = searchResult(`group-${operation}`);
		if (operation === 'block') block();
		else unblock();
		expect(message.blocked).toBe(operation === 'unblock');
		expect(getCollapsedGroupType(channel, message, true)).toBe(operation === 'block' ? 'MESSAGE_GROUP_BLOCKED' : null);
	});

	it.each(['block', 'unblock'] as const)(
		'updates a mounted list after live %s without changing its props',
		(operation) => {
			(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
			if (operation === 'unblock') block();
			const messages = searchResult(`mounted-${operation}`);
			const container = document.createElement('div');
			const root = createRoot(container);
			try {
				act(() =>
					root.render(
						createElement(SearchResultMessageList, {
							channel,
							messages,
							revealedGroupKeys: new Set<string>(),
							onGroupRevealChange: vi.fn(),
							renderMessage: (message) => message.content,
						}),
					),
				);
				expect(container.textContent?.includes(messages[0].content)).toBe(operation === 'block');
				act(() => (operation === 'block' ? block() : unblock()));
				expect(container.textContent?.includes(messages[0].content)).toBe(operation === 'unblock');
				if (operation === 'block') expect(container.querySelector('button')).not.toBeNull();
				else expect(container.querySelector('button')).toBeNull();
			} finally {
				act(() => root.unmount());
			}
		},
	);

	it('preserves explicit reveal and spam grouping while live blocking changes', () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const messages = searchResult('revealed-spam', PublicUserFlags.SPAMMER);
		function SearchView() {
			const [revealedGroupKeys, setRevealedGroupKeys] = useState<ReadonlySet<string>>(new Set());
			return createElement(SearchResultMessageList, {
				channel,
				messages,
				revealedGroupKeys,
				onGroupRevealChange: (key, revealed) => setRevealedGroupKeys(revealed ? new Set([key]) : new Set()),
				renderMessage: (message) => message.content,
			});
		}
		const container = document.createElement('div');
		const root = createRoot(container);
		const click = () => act(() => container.querySelector('button')!.click());
		try {
			act(() => root.render(createElement(SearchView)));
			expect(container.textContent).toContain('potential spammer');
			expect(container.textContent).not.toContain(messages[0].content);
			act(block);
			expect(container.textContent).toContain('blocked message');
			click();
			expect(container.textContent).toContain(messages[0].content);
			act(unblock);
			expect(container.textContent).toContain('potential spammer');
			expect(container.textContent).toContain(messages[0].content);
			click();
			expect(container.textContent).not.toContain(messages[0].content);
			act(() => LocalUserSpamOverride.markAsNotSpammer(authorId));
			expect(container.textContent).toContain(messages[0].content);
		} finally {
			act(() => root.unmount());
		}
	});

	it('does not render existing search rows for unrelated relationship events', () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const messages = searchResult('unrelated-relationships');
		const renderMessage = vi.fn((message: InstanceType<typeof Message>) => message.content);
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			act(() =>
				root.render(
					createElement(SearchResultMessageList, {
						channel,
						messages,
						revealedGroupKeys: new Set<string>(),
						onGroupRevealChange: vi.fn(),
						renderMessage,
					}),
				),
			);
			renderMessage.mockClear();
			for (let index = 0; index < 20; index++) {
				act(() => handleRelationshipAdd({id: `unrelated-${index}`, type: RelationshipTypes.FRIEND}, gatewayContext));
			}
			expect(renderMessage).not.toHaveBeenCalled();
			act(block);
			expect(container.textContent).not.toContain(messages[0].content);
			act(unblock);
			expect(renderMessage).toHaveBeenCalledTimes(1);
		} finally {
			act(() => root.unmount());
		}
	});
});
