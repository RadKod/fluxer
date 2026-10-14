// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Channel} from '@app/features/channel/models/Channel';
import type {Message} from '@app/features/messaging/models/MessagingMessage';
import {RelationshipTypes} from '@fluxer/constants/src/UserConstants';
import {autorun, getObserverTree} from 'mobx';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

const renders = vi.hoisted(() => ({count: 0}));

// Relationship state and gateway handlers are real. Quote resolution and UI/account
// dependencies are isolated so executions measure only the reply relationship observer.
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'micup.test'}}));
vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/user/state/Users', () => ({default: {cacheUsers: vi.fn(), getUser: () => undefined}}));
vi.mock('@app/features/member/state/MemberSearch', () => ({default: {handleFriendshipChange: vi.fn()}}));
vi.mock('@app/features/messaging/state/MessagingMessages', () => ({default: {handleRelationshipUpdate: vi.fn()}}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {handleRelationshipUpdate: vi.fn()}}));
vi.mock('@app/features/search/state/QuickSwitcher', () => ({default: {recomputeIfOpen: vi.fn()}}));
vi.mock('@app/features/ui/state/Notification', () => ({default: {handleRelationshipNotification: vi.fn()}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => undefined}}));
vi.mock('@app/features/moderation/state/LocalUserSpamOverride', () => ({
	default: {isUserMarkedAsSpammer: () => false},
}));
vi.mock('@app/features/messaging/state/MessageReferences', () => ({
	MessageReferenceState: {LOADED: 'LOADED'},
	default: {
		generation: 0,
		getMessageReference: (_channelId: string, _messageId: string, message: Message) => ({state: 'LOADED', message}),
		retainReference: () => () => {},
	},
}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => {
		renders.count++;
		return {i18n: {_: (descriptor: {message: string}) => descriptor.message}};
	},
}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getFormattedFullDate: () => ''}));
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

const {ReplyPreview} = await import('@app/features/channel/components/ReplyPreview');
const {CollapsedMessageVisibilityProvider} = await import(
	'@app/features/channel/components/CollapsedMessageVisibilityContext'
);
const {getCollapsedMessageGroupKey} = await import('@app/features/messaging/utils/MessageGroupingUtils');
const {default: Relationships} = await import('@app/features/relationship/state/Relationships');
const {handleRelationshipAdd} = await import('@app/features/relationship/events/RelationshipAdd');
const {handleRelationshipRemove} = await import('@app/features/relationship/events/RelationshipRemove');
const gatewayContext = {} as import('@app/features/gateway/events/EventRouter').GatewayHandlerContext;

function reply(authorId = 'target-author'): Message {
	return {
		id: 'reply',
		channelId: 'channel',
		messageReference: {channel_id: 'channel', message_id: 'target'},
		mentions: [],
		referencedMessage: {
			id: 'target',
			channelId: 'channel',
			author: {id: authorId, flags: 0},
			content: `quote by ${authorId}`,
			isUserMessage: () => true,
		},
	} as unknown as Message;
}

const block = (id: string) => act(() => handleRelationshipAdd({id, type: RelationshipTypes.BLOCKED}, gatewayContext));
const unblock = (id: string) => act(() => handleRelationshipRemove({id}, gatewayContext));

afterEach(() => {
	expect(getObserverTree(Relationships, 'relationships').observers ?? []).toHaveLength(0);
	Relationships.loadRelationships([]);
	renders.count = 0;
});

describe('ReplyPreview relationship observers', () => {
	it.each(['search', 'revealed channel'])(
		'narrows the real %s visibility provider and follows live reveal keys',
		(surface) => {
			(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
			const container = document.createElement('div');
			const root = createRoot(container);
			const owner = reply();
			const target = owner.referencedMessage!;
			const prefix = {...target, id: 'prefix', author: {...target.author, id: 'prefix-author'}} as Message;
			const messages = [prefix, target];
			const channel = {id: 'channel'} as Channel;
			let revealedGroupKeys: ReadonlySet<string> = new Set(surface === 'search' ? [] : ['target']);
			const render = () => {
				const value = {
					isMessageRevealed: (message: Message) => {
						// Search resolves a result group; the channel view only checks the live
						// window after a group is revealed. Both use the real grouping helper.
						if (surface === 'search' && !messages.some((candidate) => candidate.id === message.id)) return false;
						if (surface === 'revealed channel' && revealedGroupKeys.size === 0) return false;
						const groupKey = getCollapsedMessageGroupKey({channel, messages, messageId: message.id, treatSpam: true});
						return groupKey !== null && revealedGroupKeys.has(groupKey);
					},
				};
				act(() =>
					root.render(
						createElement(
							CollapsedMessageVisibilityProvider,
							{value},
							Array.from({length: 20}, (_, key) =>
								createElement(ReplyPreview, {
									key,
									message: owner,
									channelId: 'channel',
									messageDisplayCompact: true,
								}),
							),
						),
					),
				);
			};
			try {
				if (surface === 'revealed channel') block('target-author');
				render();
				const initial = renders.count;
				expect(initial).toBe(20);
				act(() => handleRelationshipAdd({id: 'unrelated', type: RelationshipTypes.FRIEND}, gatewayContext));
				expect(renders.count - initial).toBe(0);
				if (surface === 'search') {
					block('target-author');
					expect(container.querySelectorAll('button[disabled]')).toHaveLength(20);
					revealedGroupKeys = new Set(['target']);
					render();
				}
				expect(container.textContent).toContain('quote by target-author');
				const revealed = renders.count;
				act(() => handleRelationshipAdd({id: 'another-unrelated', type: RelationshipTypes.FRIEND}, gatewayContext));
				expect(renders.count).toBe(revealed);
				block('prefix-author');
				expect(container.querySelectorAll('button[disabled]')).toHaveLength(20);
				unblock('prefix-author');
				expect(container.textContent).toContain('quote by target-author');
				unblock('target-author');
				expect(container.textContent).toContain('quote by target-author');
				block('target-author');
				expect(container.textContent).toContain('quote by target-author');
				revealedGroupKeys = new Set();
				render();
				expect(container.querySelectorAll('button[disabled]')).toHaveLength(20);
			} finally {
				act(() => root.unmount());
			}
		},
	);

	it('suspends a shared selector after its last reader disposes and resumes with current state', () => {
		const selector = Relationships.createBlockedSelector('target-author');
		const first: Array<boolean> = [];
		const second: Array<boolean> = [];
		const disposeFirst = autorun(() => first.push(selector.get()));
		const disposeSecond = autorun(() => second.push(selector.get()));
		try {
			disposeFirst();
			block('target-author');
			expect(first).toEqual([false]);
			expect(second).toEqual([false, true]);
			disposeSecond();
			expect(getObserverTree(Relationships, 'relationships').observers ?? []).toHaveLength(0);
			unblock('target-author');
			expect(second).toEqual([false, true]);
			const resumed: Array<boolean> = [];
			const disposeResumed = autorun(() => resumed.push(selector.get()));
			try {
				block('target-author');
				expect(resumed).toEqual([false, true]);
			} finally {
				disposeResumed();
			}
		} finally {
			disposeFirst();
			disposeSecond();
		}
	});

	it('keeps 20 mounted readers asleep for unrelated FRIEND events and updates relevant block/unblock', () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			act(() =>
				root.render(
					Array.from({length: 20}, (_, key) =>
						createElement(ReplyPreview, {
							key,
							message: reply(),
							channelId: 'channel',
							messageDisplayCompact: true,
						}),
					),
				),
			);
			const initial = renders.count;
			expect(initial).toBe(20);
			act(() => handleRelationshipAdd({id: 'unrelated', type: RelationshipTypes.FRIEND}, gatewayContext));
			expect(renders.count - initial).toBe(0);
			block('target-author');
			expect(renders.count - initial).toBe(20);
			expect(container.textContent).not.toContain('quote by target-author');
			expect(container.querySelectorAll('button[disabled]')).toHaveLength(20);
			unblock('target-author');
			expect(renders.count - initial).toBe(40);
			expect(container.textContent).toContain('quote by target-author');
		} finally {
			act(() => root.unmount());
		}
	});

	it('releases the final subscriber and observes current state after remount', () => {
		const container = document.createElement('div');
		const root = createRoot(container);
		const render = () =>
			act(() =>
				root.render(
					createElement(ReplyPreview, {
						message: reply(),
						channelId: 'channel',
						messageDisplayCompact: true,
					}),
				),
			);
		try {
			render();
			expect(getObserverTree(Relationships, 'relationships').observers?.length).toBeGreaterThan(0);
			act(() => root.render(null));
			expect(getObserverTree(Relationships, 'relationships').observers ?? []).toHaveLength(0);
			const unmounted = renders.count;
			block('target-author');
			expect(renders.count).toBe(unmounted);
			render();
			expect(container.textContent).toContain('Reply hidden because the original author is blocked.');
			unblock('target-author');
			expect(container.textContent).toContain('quote by target-author');
		} finally {
			act(() => root.unmount());
		}
	});

	it('replaces the observed author without retaining the previous author subscription', () => {
		const container = document.createElement('div');
		const root = createRoot(container);
		const render = (authorId: string) =>
			act(() =>
				root.render(
					createElement(ReplyPreview, {
						message: reply(authorId),
						channelId: 'channel',
						messageDisplayCompact: true,
					}),
				),
			);
		try {
			render('first-author');
			render('second-author');
			const switched = renders.count;
			block('first-author');
			expect(renders.count).toBe(switched);
			expect(container.textContent).toContain('quote by second-author');
			block('second-author');
			expect(renders.count).toBe(switched + 1);
			expect(container.textContent).not.toContain('quote by second-author');
			unblock('second-author');
			expect(container.textContent).toContain('quote by second-author');
		} finally {
			act(() => root.unmount());
		}
	});
});
