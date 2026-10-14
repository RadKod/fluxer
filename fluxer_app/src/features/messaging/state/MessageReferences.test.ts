// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {PublicUserFlags, RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import type {Message as WireMessage} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {autorun, runInAction} from 'mobx';
import {act, createElement, StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

const updatedUsers = vi.hoisted(() => new Map<string, {toJSON: () => WireMessage['author']}>());

// UI/account stores are unrelated to the lifetime under test. The message record,
// channel window, buffers, reaction state, and MobX cache are the real modules.
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {localInstanceDomain: 'micup.test', getSnapshotOrNull: () => null},
}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/channel/state/Channels', () => ({default: {}}));
vi.mock('@app/features/gateway/transport/GatewaySessionPool', () => ({
	default: {foregroundConnection: {isConnected: false}},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => undefined}}));
vi.mock('@app/features/navigation/state/SelectedChannel', () => ({default: {currentChannelId: null}}));
vi.mock('@app/features/navigation/state/SelectedGuild', () => ({default: {}}));
vi.mock('@app/features/ui/state/Dimension', () => ({default: {}}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {}}));
vi.mock('@app/features/member/state/MemberSearch', () => ({default: {handleFriendshipChange: vi.fn()}}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {handleRelationshipUpdate: vi.fn()}}));
vi.mock('@app/features/search/state/QuickSwitcher', () => ({default: {recomputeIfOpen: vi.fn()}}));
vi.mock('@app/features/ui/state/Notification', () => ({default: {handleRelationshipNotification: vi.fn()}}));
vi.mock('@app/features/guild/state/GuildVerification', () => ({default: {handleUserUpdate: vi.fn()}}));
vi.mock('@app/features/permissions/state/Permission', () => ({default: {handleUserUpdate: vi.fn()}}));
vi.mock('@app/features/user/state/SyncedField', () => ({
	makeSyncedField: vi.fn(),
	setSyncedFieldSessionManager: vi.fn(),
	setSyncedFieldUserSettings: vi.fn(),
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		cacheUsers: vi.fn(),
		getUser: (id: string) => updatedUsers.get(id),
		handleUserUpdate: (user: WireMessage['author']) => {
			updatedUsers.set(user.id, {...user, toJSON: () => user});
		},
	},
}));
vi.mock('@app/features/messaging/commands/MessageCommands', () => ({}));
vi.mock('@app/features/messaging/utils/ReactionUtils', () => ({
	emojiEquals: (a: {name: string}, b: {name: string}) => a.name === b.name,
	getReactionKey: (id: string, emoji: {name: string}) => `${id}:${emoji.name}:`,
}));
vi.mock('@app/features/messaging/utils/EmbeddableCodeLinkContent', () => ({
	extractEmbeddableCodeLinkContent: (content: string) => content,
}));
vi.mock('@app/features/gift/utils/GiftCodeUtils', () => ({findGifts: () => []}));
vi.mock('@app/features/invite/utils/InviteUtils', () => ({findInvites: () => []}));
vi.mock('@app/features/theme/utils/ThemeUtils', () => ({findThemes: () => []}));
vi.mock('@app/features/user/models/User', () => ({
	User: class {
		readonly id: string;
		constructor(private readonly data: WireMessage['author']) {
			this.id = data.id;
		}
		toJSON() {
			return this.data;
		}
		equals(other: {id: string}) {
			return other.id === this.id;
		}
		get flags() {
			return this.data.flags;
		}
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/channel/components/CollapsedMessageVisibilityContext', () => ({
	useCollapsedMessageVisibility: () => ({isMessageRevealed: () => false}),
}));
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({
	PreloadableUserPopout: ({children}: {children: unknown}) => children,
}));
vi.mock('@app/features/messaging/components/markdown', () => ({
	SafeMarkdown: ({content}: {content: string}) => content,
}));
vi.mock('@app/features/messaging/utils/MessageNavigator', () => ({goToMessage: vi.fn()}));
vi.mock('@app/features/ui/components/Avatar', () => ({Avatar: () => null}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: () => 'author'}));

const {ChannelMessages} = await import('@app/features/messaging/state/ChannelMessages');
const {default: Messages} = await import('@app/features/messaging/state/MessagingMessages');
const {default: MessageReferences} = await import('@app/features/messaging/state/MessageReferences');
const {Message} = await import('@app/features/messaging/models/MessagingMessage');
const {default: MessageReactions} = await import('@app/features/messaging/state/MessageReactions');
const {ReplyPreview} = await import('@app/features/channel/components/ReplyPreview');
const {default: Relationships} = await import('@app/features/relationship/state/Relationships');
const {handleRelationshipAdd} = await import('@app/features/relationship/events/RelationshipAdd');
const {handleRelationshipRemove} = await import('@app/features/relationship/events/RelationshipRemove');
const {handleUserUpdate} = await import('@app/features/user/events/UserUpdate');
const gatewayContext = {} as import('@app/features/gateway/events/EventRouter').GatewayHandlerContext;

const wire = (channelId: string, id: string): WireMessage => ({
	id,
	channel_id: channelId,
	author: {
		id: '1300000000000000001',
		username: 'test',
		discriminator: '0000',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	},
	type: 0,
	flags: 0,
	pinned: false,
	tts: false,
	mention_everyone: false,
	mentions: [],
	mention_roles: [],
	content: `message ${id}`,
	timestamp: '2026-10-03T12:00:00.000Z',
});

describe('ReplyPreview active ownership', () => {
	it('shows deletion on the first render of a resident reply after tombstone eviction', () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const raw = reply('channel', 'unrendered');
		Messages.handleLoadMessagesSuccess({channelId: 'channel', messages: [raw]});
		MessageReferences.handleMessagesFetchSuccess('channel', [raw]);
		Messages.handleMessageDelete({channelId: 'channel', id: 'unrendered-target'});
		MessageReferences.handleMessageDelete('channel', 'unrendered-target');
		MessageReferences.handleMessageDeleteBulk(
			'deleted',
			Array.from({length: CAPACITY}, (_, index) => `${index}`),
		);
		expect(MessageReferences.deletedMessageIds.has('channel:unrendered-target')).toBe(false);
		const rootContainer = document.createElement('div');
		const root = createRoot(rootContainer);
		try {
			act(() =>
				root.render(
					createElement(ReplyPreview, {
						message: Messages.getMessage('channel', 'unrendered')!,
						channelId: 'channel',
						messageDisplayCompact: true,
					}),
				),
			);
			expect(rootContainer.textContent).toContain('Original message was deleted');
			expect(rootContainer.textContent).not.toContain('message unrendered-target');
		} finally {
			act(() => root.unmount());
		}
	});

	it('keeps the deleted quotation text through deletion-history eviction and remount', () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const rootContainer = document.createElement('div');
		const root = createRoot(rootContainer);
		const message = new Message(reply('channel', 'saved'));
		const render = () =>
			act(() => root.render(createElement(ReplyPreview, {message, channelId: 'channel', messageDisplayCompact: true})));
		try {
			render();
			act(() => MessageReferences.handleMessageDelete('channel', 'saved-target'));
			act(() =>
				MessageReferences.handleMessageDeleteBulk(
					'deleted',
					Array.from({length: CAPACITY}, (_, index) => `${index}`),
				),
			);
			expect(MessageReferences.deletedMessageIds.has('channel:saved-target')).toBe(false);
			expect(rootContainer.textContent).toContain('Original message was deleted');
			expect(rootContainer.textContent).not.toContain('message saved-target');
			act(() => root.render(null));
			render();
			expect(rootContainer.textContent).toContain('Original message was deleted');
		} finally {
			act(() => root.unmount());
		}
	});

	it('rehydrates a never-rendered self-reply author and spam flags through a real USER_UPDATE', () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const raw = reply('channel', 'self-reply');
		Messages.handleLoadMessagesSuccess({channelId: 'channel', messages: [raw]});
		expect(Messages.getMessage('channel', 'self-reply-target')).toBeUndefined();
		expect(MessageReferences.cachedMessages.size).toBe(0);
		expect(MessageReferences.activeReferences.size).toBe(0);
		const updatedAuthor = {
			...raw.author,
			username: 'new username',
			avatar: 'new-avatar',
			flags: PublicUserFlags.SPAMMER,
		};
		handleUserUpdate(updatedAuthor, gatewayContext);
		const updatedOwner = Messages.getMessage('channel', 'self-reply')!;
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			act(() =>
				root.render(
					createElement(ReplyPreview, {message: updatedOwner, channelId: 'channel', messageDisplayCompact: true}),
				),
			);
			expect(container.textContent).toContain('Reply hidden because the original author is marked as a spammer.');
			expect(container.textContent).not.toContain('message self-reply-target');
			expect(updatedOwner.referencedMessage?.author.toJSON()).toMatchObject(updatedAuthor);
		} finally {
			act(() => root.unmount());
		}
	});

	it.each(['active edit', 'inactive edit'])('invalidates an evicted owner snapshot after %s and remount', (order) => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement('div');
		const root = createRoot(container);
		const message = new Message(reply('channel', 'saved'));
		MessageReferences.handleMessageCreate(message.toJSON(), false);
		const render = () =>
			act(() =>
				root.render(
					createElement(
						StrictMode,
						null,
						createElement(ReplyPreview, {
							message,
							channelId: 'channel',
							messageDisplayCompact: true,
						}),
					),
				),
			);
		try {
			render();
			if (order === 'inactive edit') act(() => root.render(null));
			if (order === 'active edit') {
				act(() =>
					MessageReferences.handleMessageUpdate({...wire('channel', 'saved-target'), content: 'latest quote edit'}),
				);
				expect(container.textContent).toContain('latest quote edit');
			}
			act(() => churn(CAPACITY + 1));
			if (order === 'active edit') act(() => root.render(null));
			else
				act(() =>
					MessageReferences.handleMessageUpdate({...wire('channel', 'saved-target'), content: 'latest quote edit'}),
				);
			expect(MessageReferences.activeReferences.size).toBe(0);
			expect(MessageReferences.cachedMessages.size).toBe(CAPACITY);
			render();
			expect(container.textContent).toContain('Original message failed to load');
			expect(container.textContent).not.toContain('message saved-target');
			act(() => {
				const reloaded = {...wire('channel', 'saved-target'), content: 'reloaded quote'};
				Messages.handleLoadMessagesSuccess({channelId: 'channel', messages: [reloaded]});
				MessageReferences.handleMessagesFetchSuccess('channel', [reloaded]);
			});
			expect(container.textContent).toContain('reloaded quote');
		} finally {
			act(() => root.unmount());
		}
	});

	it.each(['live', 'off-window'])('hides an edited %s quote on block and restores the edit on unblock', (location) => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement('div');
		const root = createRoot(container);
		const message = new Message(reply('channel', 'saved'));
		if (location === 'live') {
			Messages.handleLoadMessagesSuccess({channelId: 'channel', messages: [wire('channel', 'saved-target')]});
		}
		try {
			act(() => root.render(createElement(ReplyPreview, {message, channelId: 'channel', messageDisplayCompact: true})));
			act(() =>
				MessageReferences.handleMessageUpdate({...wire('channel', 'saved-target'), content: 'latest private quote'}),
			);
			act(() => churn(CAPACITY + 1));
			expect(MessageReferences.cachedMessages.has('channel:saved-target')).toBe(false);
			act(() =>
				handleRelationshipAdd(
					{id: message.referencedMessage!.author.id, type: RelationshipTypes.BLOCKED},
					gatewayContext,
				),
			);
			if (location === 'live') expect(Messages.getMessage('channel', 'saved-target')?.blocked).toBe(true);
			expect(container.textContent).toContain('Reply hidden because the original author is blocked.');
			expect(container.textContent).not.toContain('latest private quote');
			act(() => handleRelationshipRemove({id: message.referencedMessage!.author.id}, gatewayContext));
			if (location === 'live') expect(Messages.getMessage('channel', 'saved-target')?.blocked).toBe(false);
			expect(container.textContent).toContain('latest private quote');
			expect(container.textContent).not.toContain('Reply hidden');
		} finally {
			act(() => root.unmount());
		}
		expect(MessageReferences.activeReferences.size).toBe(0);
	});

	it('keeps a StrictMode view reactive through eviction, target edits, deletion and unmount', () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		const message = new Message(reply('channel', 'saved'));
		try {
			act(() =>
				root.render(
					createElement(
						StrictMode,
						null,
						createElement(ReplyPreview, {
							message,
							channelId: 'channel',
							messageDisplayCompact: true,
						}),
					),
				),
			);
			expect(container.textContent).toContain('message saved-target');
			expect(MessageReferences.activeReferences.get('channel:saved-target')?.count).toBe(1);
			act(() => churn());
			act(() => MessageReferences.handleGatewayReady());
			expect(MessageReferences.activeReferences.get('channel:saved-target')?.count).toBe(1);
			act(() =>
				MessageReferences.handleMessageUpdate({
					...wire('channel', 'saved-target'),
					content: 'edited visible quote',
				}),
			);
			expect(container.textContent).toContain('edited visible quote');
			act(() => MessageReferences.handleMessageDelete('channel', 'saved-target'));
			expect(container.textContent).toContain('Original message was deleted');
		} finally {
			act(() => root.unmount());
			container.remove();
		}
		expect(MessageReferences.activeReferences.size).toBe(0);
	});

	it('releases the old target when a visible reply changes reference and fallback', () => {
		const container = document.createElement('div');
		const root = createRoot(container);
		const render = (message: InstanceType<typeof Message>) =>
			act(() =>
				root.render(
					createElement(ReplyPreview, {
						message,
						channelId: 'channel',
						messageDisplayCompact: true,
					}),
				),
			);
		try {
			render(new Message(reply('channel', 'first')));
			render(new Message(reply('channel', 'second')));
			expect(container.textContent).toContain('message second-target');
			expect(MessageReferences.activeReferences.has('channel:first-target')).toBe(false);
			expect(MessageReferences.activeReferences.get('channel:second-target')?.count).toBe(1);
		} finally {
			act(() => root.unmount());
		}
		expect(MessageReferences.activeReferences.size).toBe(0);
	});

	it('preserves an edited active quote when USER_UPDATE recreates an evicted nested snapshot', () => {
		const container = document.createElement('div');
		const root = createRoot(container);
		const raw = reply('channel', 'pin');
		Messages.handleLoadMessagesSuccess({channelId: 'channel', messages: [raw]});
		MessageReferences.handleMessagesFetchSuccess('channel', [raw]);
		const message = Messages.getMessage('channel', 'pin')!;
		const render = (viewMessage: InstanceType<typeof Message>) =>
			act(() =>
				root.render(
					createElement(ReplyPreview, {
						message: viewMessage,
						channelId: 'channel',
						messageDisplayCompact: true,
					}),
				),
			);
		try {
			render(message);
			act(() =>
				MessageReferences.handleMessageUpdate({...wire('channel', 'pin-target'), content: 'latest target edit'}),
			);
			act(() => churn(CAPACITY + 1));
			expect(MessageReferences.cachedMessages.has('channel:pin-target')).toBe(false);
			const active = MessageReferences.activeReferences.get('channel:pin-target');
			updatedUsers.set(raw.author.id, {toJSON: () => ({...raw.author, username: 'renamed'})});
			expect(Messages.handleUserUpdate({user: {id: raw.author.id}})).toBe(true);
			const updatedReply = Messages.getMessage('channel', 'pin')!;
			expect(updatedReply.referencedMessage).not.toBe(message.referencedMessage);
			expect(updatedReply.referencedMessage?.snapshotIdentity).toBe(message.referencedMessage?.snapshotIdentity);
			expect(updatedReply.referencedMessage?.content).toBe('message pin-target');
			render(updatedReply);
			expect(container.textContent).toContain('latest target edit');
			expect(MessageReferences.activeReferences.get('channel:pin-target')).toBe(active);
		} finally {
			act(() => root.unmount());
		}
	});

	it('adopts a newly loaded fallback and continues receiving edits after cold eviction', () => {
		const container = document.createElement('div');
		const root = createRoot(container);
		const loaded = reply('channel', 'saved');
		const {referenced_message: _target, ...unloaded} = loaded;
		const render = (message: InstanceType<typeof Message>) =>
			act(() =>
				root.render(
					createElement(ReplyPreview, {
						message,
						channelId: 'channel',
						messageDisplayCompact: true,
					}),
				),
			);
		try {
			render(new Message(unloaded));
			expect(container.textContent).toContain('Original message failed to load');
			render(new Message(loaded));
			expect(container.textContent).toContain('message saved-target');
			act(() => churn(CAPACITY + 1));
			act(() =>
				MessageReferences.handleMessageUpdate({...wire('channel', 'saved-target'), content: 'newly adopted edit'}),
			);
			expect(container.textContent).toContain('newly adopted edit');
			expect(MessageReferences.activeReferences.get('channel:saved-target')?.count).toBe(1);
		} finally {
			act(() => root.unmount());
		}
	});
});

function reply(channelId: string, id: string): WireMessage {
	const targetId = `${id}-target`;
	return {
		...wire(channelId, id),
		message_reference: {type: 0, channel_id: channelId, message_id: targetId},
		referenced_message: wire(channelId, targetId),
	};
}

const CAPACITY = 1000;
function churn(count = CAPACITY) {
	for (let index = 0; index < count; index++) {
		MessageReferences.handleMessageCreate(reply('other', `reply-${index}`), false);
	}
}

afterEach(() => {
	expect(MessageReferences.activeReferences.size).toBe(0);
	ChannelMessages.forEach((_messages, channelId) => ChannelMessages.clear(channelId));
	MessageReferences.handleGatewayReady();
	MessageReactions.handleGatewayReady();
	updatedUsers.clear();
	Relationships.loadRelationships([]);
});

describe('bounded quoted message cache', () => {
	it.each([null, undefined])(
		'keeps invalidation when an explicit %s snapshot update preserves old content',
		(referencedMessage) => {
			const owner = new Message(reply('channel', 'saved'));
			MessageReferences.retainReference('channel', 'saved-target', owner.referencedMessage)();
			churn(CAPACITY + 1);
			const updatedOwner = owner.withUpdates({referenced_message: referencedMessage});
			expect(
				MessageReferences.getMessageReference('channel', 'saved-target', updatedOwner.referencedMessage).state,
			).toBe('NOT_LOADED');
		},
	);

	it('keeps an evicted owner invalid after an unrelated immutable owner update', () => {
		const owner = new Message(reply('channel', 'saved'));
		MessageReferences.retainReference('channel', 'saved-target', owner.referencedMessage)();
		churn(CAPACITY + 1);
		MessageReferences.handleMessageUpdate({...wire('channel', 'saved-target'), content: 'inactive target edit'});
		const updatedOwner = owner.withUpdates({author: {...owner.author.toJSON(), username: 'renamed'}});
		expect(MessageReferences.getMessageReference('channel', 'saved-target', updatedOwner.referencedMessage).state).toBe(
			'NOT_LOADED',
		);
		expect(updatedOwner.referencedMessage?.snapshotIdentity).toBe(owner.referencedMessage?.snapshotIdentity);
		expect(updatedOwner.referencedMessage?.toJSON()).not.toHaveProperty('snapshotIdentity');
		expect(Object.keys(updatedOwner.referencedMessage!.snapshotIdentity)).toEqual([]);
		const refreshedOwner = updatedOwner.withUpdates({
			referenced_message: {...wire('channel', 'saved-target'), content: 'fresh snapshot'},
		});
		expect(refreshedOwner.referencedMessage).not.toBe(owner.referencedMessage);
		expect(refreshedOwner.referencedMessage?.snapshotIdentity).not.toBe(owner.referencedMessage?.snapshotIdentity);
		const refreshed = MessageReferences.getMessageReference(
			'channel',
			'saved-target',
			refreshedOwner.referencedMessage,
		);
		expect(refreshed.state).toBe('LOADED');
		if (refreshed.state === 'LOADED') expect(refreshed.message.content).toBe('fresh snapshot');
	});

	it('does not revive an evicted edited snapshot when a second view mounts before the final release', () => {
		const first = new Message(wire('channel', 'target'));
		const second = new Message(wire('channel', 'target'));
		const releaseFirst = MessageReferences.retainReference('channel', 'target', first);
		MessageReferences.handleMessageUpdate({...wire('channel', 'target'), content: 'latest quote edit'});
		churn(CAPACITY + 1);
		const releaseSecond = MessageReferences.retainReference('channel', 'target', second);
		releaseFirst();
		releaseSecond();
		expect(MessageReferences.getMessageReference('channel', 'target', first).state).toBe('NOT_LOADED');
		expect(MessageReferences.getMessageReference('channel', 'target', second).state).toBe('NOT_LOADED');
	});

	it('preserves an unchanged owner across release before its LRU entry is evicted', () => {
		const target = new Message(wire('channel', 'target'));
		const release = MessageReferences.retainReference('channel', 'target', target);
		release();
		expect(MessageReferences.cachedMessages.has('channel:target')).toBe(false);
		expect(MessageReferences.getMessageReference('channel', 'target', target).state).toBe('LOADED');
		churn(CAPACITY + 1);
		expect(MessageReferences.getMessageReference('channel', 'target', target).state).toBe('NOT_LOADED');
	});

	it('shares invalidation between owners without reviving an old snapshot with a new target token', () => {
		const first = new Message(wire('channel', 'target'));
		const second = new Message(wire('channel', 'target'));
		const releaseFirst = MessageReferences.retainReference('channel', 'target', first);
		const releaseSecond = MessageReferences.retainReference('channel', 'target', second);
		MessageReferences.handleMessageUpdate({...wire('channel', 'target'), content: 'latest edit'});
		churn(CAPACITY + 1);
		releaseFirst();
		expect(MessageReferences.getMessageReference('channel', 'target', second).state).toBe('LOADED');
		releaseSecond();
		for (const owner of [first, second]) {
			expect(MessageReferences.getMessageReference('channel', 'target', owner).state).toBe('NOT_LOADED');
		}
		MessageReferences.handleMessageCreate(reply('channel', 'fresh'), false);
		const fresh = {
			...reply('channel', 'fresh'),
			message_reference: {type: 0, channel_id: 'channel', message_id: 'target'},
			referenced_message: {...wire('channel', 'target'), content: 'fresh target'},
		};
		MessageReferences.handleMessageCreate(fresh, false);
		expect(MessageReferences.getMessageReference('channel', 'target', first).state).toBe('LOADED');
		churn(CAPACITY + 1);
		expect(MessageReferences.getMessageReference('channel', 'target', first).state).toBe('NOT_LOADED');
	});

	it('clears payload-free owner validity metadata on channel deletion and gateway reset', () => {
		const owner = new Message(wire('channel', 'target'));
		const release = MessageReferences.retainReference('channel', 'target', owner);
		release();
		MessageReferences.handleChannelDelete('channel');
		expect(MessageReferences.getMessageReference('channel', 'target', owner).state).toBe('NOT_LOADED');
		const metadata = MessageReferences as unknown as {
			referenceTokens: Map<string, unknown>;
			cacheOrder: {size: number};
		};
		expect(metadata.referenceTokens.size).toBe(0);
		expect(metadata.cacheOrder.size).toBe(0);
		MessageReferences.handleGatewayReady();
		expect(MessageReferences.getMessageReference('channel', 'target', owner).state).toBe('LOADED');
	});

	it('bounds payload-free tokens after repeated owner release and drops active tokens after eviction', () => {
		for (let index = 0; index <= CAPACITY; index++) {
			const target = new Message(wire('channel', `target-${index}`));
			MessageReferences.retainReference('channel', target.id, target)();
		}
		const metadata = MessageReferences as unknown as {referenceTokens: Map<string, unknown>};
		expect(metadata.referenceTokens.size).toBe(CAPACITY);
		expect(MessageReferences.cachedMessages.size).toBe(0);
		const release = MessageReferences.retainReference('channel', 'active', new Message(wire('channel', 'active')));
		churn(CAPACITY + 1);
		expect(metadata.referenceTokens.size).toBe(CAPACITY + 1);
		release();
		expect(metadata.referenceTokens.size).toBe(CAPACITY);
	});

	it('bounds payloads and history metadata after repeated window replacements', () => {
		for (let index = 0; index <= CAPACITY; index++) {
			const message = reply('channel', `reply-${index}`);
			Messages.handleLoadMessagesSuccess({channelId: 'channel', messages: [message]});
			MessageReferences.handleMessagesFetchSuccess('channel', [message]);
		}
		expect(ChannelMessages.get('channel')?.has('reply-0', true)).toBe(false);
		expect(MessageReferences.cachedMessages.size).toBeLessThanOrEqual(CAPACITY);
		expect(MessageReferences.cachedMessages.has('channel:reply-0-target')).toBe(false);
		const metadata = MessageReferences as unknown as Record<string, Map<string, unknown> | undefined>;
		for (const name of ['referenceCount', 'referencingMessages', 'referenceVersions']) {
			expect(metadata[name]?.size ?? 0).toBeLessThanOrEqual(CAPACITY);
		}
	});

	it('evicts the least recently read target', () => {
		churn();
		MessageReferences.getMessageReference('other', 'reply-0-target');
		MessageReferences.handleMessageCreate(reply('next', 'next'), false);
		expect(MessageReferences.cachedMessages.has('other:reply-0-target')).toBe(true);
		expect(MessageReferences.cachedMessages.has('other:reply-1-target')).toBe(false);
	});

	it('uses the reply-owned snapshot after cold eviction for pin, saved and search owners', () => {
		const owners = ['pin', 'saved', 'search'].map((id) => new Message(reply('channel', id)));
		for (const message of owners) MessageReferences.handleMessageCreate(message.toJSON(), false);
		churn();
		for (const message of owners) {
			expect(MessageReferences.cachedMessages.has(`channel:${message.id}-target`)).toBe(false);
			const resolution = MessageReferences.getMessageReference(
				'channel',
				`${message.id}-target`,
				message.referencedMessage,
			);
			expect(resolution.state).toBe('LOADED');
			if (resolution.state === 'LOADED') expect(resolution.message.content).toBe(`message ${message.id}-target`);
		}
	});

	it('never lets fallback or a stale refetch override a deletion tombstone', () => {
		const message = new Message(reply('channel', 'pin'));
		MessageReferences.handleMessageCreate(message.toJSON(), false);
		MessageReferences.handleMessageDelete('channel', 'pin-target');
		churn();
		MessageReferences.handleMessagesFetchSuccess('channel', [message.toJSON()]);
		expect(MessageReferences.getMessageReference('channel', 'pin-target', message.referencedMessage).state).toBe(
			'DELETED',
		);
	});

	it('bounds deletion history and evicts the least recently read tombstone', () => {
		MessageReferences.handleMessageDeleteBulk(
			'deleted',
			Array.from({length: CAPACITY}, (_, index) => `${index}`),
		);
		expect(MessageReferences.getMessageReference('deleted', '0').state).toBe('DELETED');
		MessageReferences.handleMessageDelete('deleted', 'next');
		expect(MessageReferences.deletedMessageIds.size).toBe(CAPACITY);
		expect(MessageReferences.getMessageReference('deleted', '0').state).toBe('DELETED');
		expect(MessageReferences.getMessageReference('deleted', '1').state).toBe('NOT_LOADED');
		expect(MessageReferences.getMessageReference('deleted', '1', null).state).toBe('DELETED');
	});

	it('refreshes a duplicate deletion without retaining more tombstones', () => {
		MessageReferences.handleMessageDeleteBulk(
			'deleted',
			Array.from({length: CAPACITY}, (_, index) => `${index}`),
		);
		MessageReferences.handleMessageDelete('deleted', '0');
		MessageReferences.handleMessageDelete('deleted', 'next');
		expect(MessageReferences.deletedMessageIds.size).toBe(CAPACITY);
		expect(MessageReferences.deletedMessageIds.has('deleted:0')).toBe(true);
		expect(MessageReferences.deletedMessageIds.has('deleted:1')).toBe(false);
	});

	it('keeps an active deletion reactive after tombstone eviction and stale refetch', () => {
		const target = new Message(wire('channel', 'target'));
		const release = MessageReferences.retainReference('channel', 'target', target);
		const states: Array<string> = [];
		const dispose = autorun(() =>
			states.push(MessageReferences.getMessageReference('channel', 'target', target).state),
		);
		let releaseSecond: (() => void) | undefined;
		try {
			MessageReferences.handleMessageDelete('channel', 'target');
			MessageReferences.handleMessageDeleteBulk(
				'deleted',
				Array.from({length: CAPACITY}, (_, index) => `${index}`),
			);
			expect(MessageReferences.deletedMessageIds.has('channel:target')).toBe(false);
			MessageReferences.handleMessagesFetchSuccess('channel', [
				wire('channel', 'target'),
				{...reply('channel', 'target'), message_reference: {type: 0, channel_id: 'channel', message_id: 'target'}},
			]);
			MessageReferences.handleMessageUpdate({...wire('channel', 'target'), content: 'stale target'});
			expect(states.at(-1)).toBe('DELETED');
			expect(states.slice(1)).not.toContain('LOADED');
			releaseSecond = MessageReferences.retainReference('channel', 'target', new Message(wire('channel', 'target')));
			release();
			expect(MessageReferences.getMessageReference('channel', 'target').state).toBe('DELETED');
			releaseSecond();
			expect(MessageReferences.getMessageReference('channel', 'target', target).state).toBe('DELETED');
		} finally {
			dispose();
			release();
			releaseSecond?.();
		}
	});

	it('preserves a released owner deletion after its tombstone is evicted', () => {
		const target = new Message(wire('channel', 'target'));
		MessageReferences.retainReference('channel', 'target', target)();
		MessageReferences.handleMessageDelete('channel', 'target');
		MessageReferences.handleMessageDeleteBulk(
			'deleted',
			Array.from({length: CAPACITY}, (_, index) => `${index}`),
		);
		expect(MessageReferences.deletedMessageIds.has('channel:target')).toBe(false);
		MessageReferences.handleMessagesFetchSuccess('channel', [
			{...reply('channel', 'target'), message_reference: {type: 0, channel_id: 'channel', message_id: 'target'}},
		]);
		expect(MessageReferences.getMessageReference('channel', 'target', target).state).toBe('DELETED');
	});

	it.each(['read', 'retain'])(
		'keeps deletion for an invalid owner after a fresh target %s and immediate release',
		(mode) => {
			const owner = new Message(wire('channel', 'target'));
			MessageReferences.retainReference('channel', 'target', owner)();
			churn(CAPACITY + 1);
			expect(MessageReferences.getMessageReference('channel', 'target', owner).state).toBe('NOT_LOADED');
			MessageReferences.handleMessageCreate(
				{
					...reply('channel', 'refreshed'),
					message_reference: {type: 0, channel_id: 'channel', message_id: 'target'},
					referenced_message: {...wire('channel', 'target'), content: 'fresh target'},
				},
				false,
			);
			const release = mode === 'retain' ? MessageReferences.retainReference('channel', 'target', owner) : undefined;
			if (mode === 'read') {
				const resolution = MessageReferences.getMessageReference('channel', 'target', owner);
				expect(resolution.state).toBe('LOADED');
				if (resolution.state === 'LOADED') expect(resolution.message.content).toBe('fresh target');
			}
			runInAction(() => {
				MessageReferences.handleMessageDelete('channel', 'target');
				release?.();
			});
			MessageReferences.handleMessageDeleteBulk(
				'deleted',
				Array.from({length: CAPACITY}, (_, index) => `${index}`),
			);
			expect(MessageReferences.deletedMessageIds.has('channel:target')).toBe(false);
			expect(MessageReferences.getMessageReference('channel', 'target', owner).state).toBe('DELETED');
		},
	);

	it('keeps deletion learned by a previously unseen owner through eviction and resets it on ready', () => {
		const target = new Message(wire('channel', 'target'));
		MessageReferences.handleMessageDelete('channel', 'target');
		expect(MessageReferences.getMessageReference('channel', 'target', target).state).toBe('DELETED');
		MessageReferences.handleMessageDeleteBulk(
			'deleted',
			Array.from({length: CAPACITY}, (_, index) => `${index}`),
		);
		expect(MessageReferences.deletedMessageIds.has('channel:target')).toBe(false);
		expect(MessageReferences.getMessageReference('channel', 'target', target).state).toBe('DELETED');
		MessageReferences.handleGatewayReady();
		expect(MessageReferences.deletedMessageIds.size).toBe(0);
		expect(MessageReferences.getMessageReference('channel', 'target', target).state).toBe('LOADED');
	});

	it('clears bounded deletion order on channel deletion and ready', () => {
		MessageReferences.handleMessageDelete('channel', 'target');
		MessageReferences.handleMessageDelete('other', 'target');
		MessageReferences.handleChannelDelete('channel');
		expect(MessageReferences.deletedMessageIds.has('channel:target')).toBe(false);
		expect(MessageReferences.getMessageReference('other', 'target').state).toBe('DELETED');
		const metadata = MessageReferences as unknown as {deletedOrder: {size: number}};
		expect(metadata.deletedOrder.size).toBe(1);
		MessageReferences.handleGatewayReady();
		expect(metadata.deletedOrder.size).toBe(0);
	});

	it('touches tombstone recency without observable writes during render reads', () => {
		MessageReferences.handleMessageDelete('channel', 'target');
		let reads = 0;
		const dispose = autorun(() => {
			MessageReferences.getMessageReference('channel', 'target');
			reads++;
		});
		MessageReferences.getMessageReference('channel', 'target');
		MessageReferences.getMessageReference('channel', 'target');
		expect(reads).toBe(1);
		dispose();
	});

	it('rejects a snapshot for another target', () => {
		expect(
			MessageReferences.getMessageReference('channel', 'target', new Message(wire('channel', 'other'))).state,
		).toBe('NOT_LOADED');
	});

	it('resolves a TTS wire snapshot without replacing newer live reactions', () => {
		MessageReactions.handleReactionAdd('target', 'user', {name: '👍'});
		const result = MessageReferences.getMessageReference('channel', 'target', {
			...wire('channel', 'target'),
			reactions: [],
		});
		expect(result.state).toBe('LOADED');
		if (result.state === 'LOADED') expect(result.message.reactions).toMatchObject([{count: 1}]);
	});

	it('touches cold recency without observable writes during render reads', () => {
		MessageReferences.handleMessageCreate(reply('channel', 'reply'), false);
		let reads = 0;
		const dispose = autorun(() => {
			MessageReferences.getMessageReference('channel', 'reply-target');
			reads++;
		});
		MessageReferences.getMessageReference('channel', 'reply-target');
		MessageReferences.getMessageReference('channel', 'reply-target');
		expect(reads).toBe(1);
		dispose();
	});

	it('enumerates cold and active payloads synchronously for member retention', () => {
		const release = MessageReferences.retainReference('channel', 'active', new Message(wire('channel', 'active')));
		MessageReferences.handleMessageCreate(reply('channel', 'cold'), false);
		expect(Array.from(MessageReferences.getReferencedMessages(), (message) => message.id)).toEqual([
			'cold-target',
			'active',
		]);
		release();
	});

	it('keeps observed replies loaded and reactive through eviction and target edits', () => {
		const message = new Message(reply('channel', 'pin'));
		MessageReferences.retainReference('channel', 'pin-target', message.referencedMessage);
		const contents: Array<string> = [];
		const dispose = autorun(() => {
			const result = MessageReferences.getMessageReference('channel', 'pin-target', message.referencedMessage);
			contents.push(result.state === 'LOADED' ? result.message.content : result.state);
		});
		try {
			churn();
			MessageReferences.handleMessageUpdate({...wire('channel', 'pin-target'), content: 'edited'});
			expect(contents.at(-1)).toBe('edited');
			expect(contents).not.toContain('NOT_LOADED');
			MessageReferences.handleMessageDelete('channel', 'pin-target');
			expect(contents.at(-1)).toBe('DELETED');
		} finally {
			dispose();
			MessageReferences.releaseReference('channel', 'pin-target');
		}
	});

	it('shares an active target until its last view releases it', () => {
		const target = new Message(wire('channel', 'target'));
		MessageReferences.retainReference('channel', 'target', target);
		MessageReferences.retainReference('channel', 'target', target);
		MessageReferences.releaseReference('channel', 'target');
		churn();
		expect(MessageReferences.getMessageReference('channel', 'target').state).toBe('LOADED');
		MessageReferences.releaseReference('channel', 'target');
		expect(MessageReferences.getMessageReference('channel', 'target').state).toBe('NOT_LOADED');
	});

	it('hydrates an unresolved active target from a second view and preserves later edits', () => {
		const releaseUnloaded = MessageReferences.retainReference('channel', 'target');
		const target = new Message(wire('channel', 'target'));
		const releaseLoaded = MessageReferences.retainReference('channel', 'target', target);
		try {
			expect(MessageReferences.activeReferences.get('channel:target')?.message).toBe(target);
			expect(MessageReferences.activeReferences.get('channel:target')?.count).toBe(2);
			expect(Array.from(MessageReferences.getReferencedMessages())).toContain(target);
			churn(CAPACITY + 1);
			MessageReferences.handleMessageUpdate({...wire('channel', 'target'), content: 'second owner edit'});
			const result = MessageReferences.getMessageReference('channel', 'target');
			expect(result.state).toBe('LOADED');
			if (result.state === 'LOADED') expect(result.message.content).toBe('second owner edit');
		} finally {
			releaseUnloaded();
			releaseLoaded();
		}
	});

	it('refreshes an active target captured from the live store when history replaces it', () => {
		const target = wire('channel', 'target');
		Messages.handleLoadMessagesSuccess({channelId: 'channel', messages: [target]});
		MessageReferences.handleMessagesFetchSuccess('channel', [target]);
		const release = MessageReferences.retainReference('channel', 'target');
		try {
			expect(MessageReferences.cachedMessages.has('channel:target')).toBe(false);
			const edited = {...target, content: 'refetched target edit', edited_timestamp: '2026-10-04T12:00:00.000Z'};
			Messages.handleLoadMessagesSuccess({channelId: 'channel', messages: [edited]});
			MessageReferences.handleMessagesFetchSuccess('channel', [edited]);
			expect(Messages.getMessage('channel', 'target')?.content).toBe('refetched target edit');
			const result = MessageReferences.getMessageReference('channel', 'target');
			expect(result.state).toBe('LOADED');
			if (result.state === 'LOADED') expect(result.message.content).toBe('refetched target edit');
		} finally {
			release();
		}
	});

	it('keeps real reaction state after eviction and a target content edit', () => {
		const target = new Message(wire('channel', 'target'));
		MessageReferences.retainReference('channel', 'target', target);
		churn();
		MessageReactions.handleReactionAdd('target', 'user', {name: '👍'});
		MessageReferences.handleMessageUpdate({...wire('channel', 'target'), content: 'edited'});
		const result = MessageReferences.getMessageReference('channel', 'target');
		expect(result.state).toBe('LOADED');
		if (result.state === 'LOADED') expect(result.message.reactions).toMatchObject([{count: 1, emoji: {name: '👍'}}]);
		MessageReferences.releaseReference('channel', 'target');
	});

	it('clears active and cold references on channel deletion', () => {
		MessageReferences.retainReference('channel', 'target', new Message(wire('channel', 'target')));
		MessageReferences.handleMessageCreate(reply('channel', 'reply'), false);
		MessageReferences.handleChannelDelete('channel');
		expect(MessageReferences.cachedMessages.size).toBe(0);
		expect(MessageReferences.getMessageReference('channel', 'target').state).toBe('NOT_LOADED');
	});

	it('resets active payloads on ready and ignores a retired view disposer', () => {
		const releaseOld = MessageReferences.retainReference('channel', 'target', new Message(wire('channel', 'target')));
		MessageReferences.handleGatewayReady();
		expect(MessageReferences.activeReferences.size).toBe(0);
		const releaseNew = MessageReferences.retainReference('channel', 'target', new Message(wire('channel', 'target')));
		releaseOld();
		expect(MessageReferences.activeReferences.get('channel:target')?.count).toBe(1);
		releaseNew();
		releaseNew();
		expect(MessageReferences.activeReferences.size).toBe(0);
	});
});
