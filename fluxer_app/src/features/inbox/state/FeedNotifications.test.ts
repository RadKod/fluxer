// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ForegroundPromoteCoordinator,
	type ForegroundPromoteHost,
} from '@app/features/gateway/transport/ForegroundPromoteCoordinator';
import {AccountScopedWork, AccountScopedWorkTransitionReason} from '@app/features/platform/state/AccountScopedWork';
import type {
	FeedNotificationAckResponse,
	FeedNotificationResponse,
	FeedNotificationStateResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {act, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const persistence = vi.hoisted(() => ({onRehydrated: () => {}}));
const modalCommands = vi.hoisted(() => ({push: vi.fn(), modal: (render: () => unknown) => render}));
const feedNotificationCommands = vi.hoisted(() => ({
	refresh: vi.fn(),
	loadMore: vi.fn(),
	retry: vi.fn(),
	markRead: vi.fn(),
}));
const passthrough = ({children}: {children: ReactNode}) => children;

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => ({
	makePersistent: async (
		_store: unknown,
		_key: string,
		_properties: unknown,
		options?: {onRehydrated?: () => void},
	) => {
		persistence.onRehydrated = options?.onRehydrated ?? (() => {});
	},
}));
// The activity tab's own dependencies, for the row test at the end.
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', async () => {
	const {setupI18n} = await import('@lingui/core');
	const i18n = setupI18n({locale: 'en-US', messages: {'en-US': {}}});
	return {useLingui: () => ({i18n})};
});
vi.mock('@app/features/ui/commands/ModalCommands', () => modalCommands);
vi.mock('@app/features/inbox/commands/FeedNotificationCommands', () => feedNotificationCommands);
vi.mock('@app/features/inbox/components/FeedNotificationPostModal', () => ({FeedNotificationPostModal: () => null}));
vi.mock('@app/features/channel/components/TimestampWithTooltip', () => ({TimestampWithTooltip: passthrough}));
vi.mock('@app/features/ui/avatars/AvatarStack', () => ({AvatarStack: () => null}));
vi.mock('@app/features/ui/button/Button', () => ({Button: () => null}));
vi.mock('@app/features/ui/components/MentionBadge', () => ({
	MentionBadge: ({mentionCount, max}: {mentionCount: number; max?: number}) =>
		createElement('span', {'data-max': max}, String(mentionCount)),
}));
vi.mock('@app/features/ui/components/Scroller', () => ({Scroller: passthrough}));
vi.mock('@app/features/ui/components/Spinner', () => ({Spinner: () => null}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passthrough}));
vi.mock('@app/features/ui/state/Popout', () => ({default: {close: vi.fn()}}));
vi.mock('@app/features/ui/utils/AppZoomUtils', () => ({getAppRemScale: () => 1}));
vi.mock('@app/features/user/commands/UserProfileCommands', () => ({openUserProfile: vi.fn()}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getRelativeDateString: () => ''}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({getNickname: (user: {username: string}) => user.username}));
// Happy-dom has no layout, so the virtualizer is replaced by one that shows every row.
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: ({count}: {count: number}) => ({
		getVirtualItems: () => Array.from({length: count}, (_, index) => ({index, start: 0})),
		getTotalSize: () => 0,
		measureElement: () => {},
	}),
}));

const {default: FeedNotifications, MAX_LOADED_FEED_NOTIFICATIONS} = await import(
	'@app/features/inbox/state/FeedNotifications'
);
const {handleFeedNotificationCreate} = await import('@app/features/feed/events/FeedNotificationCreate');
const {FeedActivityContent, FeedActivityTabIcon} = await import('@app/features/inbox/components/FeedActivityContent');

function wireUser(id: string) {
	return {
		id,
		username: `user${id}`,
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	};
}

function wireNotification(id: number, fields: Partial<FeedNotificationResponse> = {}): FeedNotificationResponse {
	return {
		id: String(id),
		type: 'post_like',
		post_id: '500',
		comment_id: null,
		actors: [wireUser('7')],
		actor_count: 1,
		updated_at: new Date(1_800_000_000_000 + id * 1000).toISOString(),
		...fields,
	};
}

function page(from: number, count: number): Array<FeedNotificationResponse> {
	return Array.from({length: count}, (_, index) => wireNotification(from - index));
}

const ids = () => FeedNotifications.notifications.map((notification) => notification.id);

describe('FeedNotifications', () => {
	beforeEach(() => {
		FeedNotifications.handleGatewayReady();
		FeedNotifications.lastReadAt = 0;
	});

	it('clears transient work when a different instance of the same user rehydrates its cursor', () => {
		FeedNotifications.handleGatewayReady(
			{last_read_at: null, unread_count: 3, unread_seq: 5, unread_epoch: 7},
			'same-user',
		);
		FeedNotifications.handleReadFailure({readAt: 1000, seq: 5, epoch: 7});
		FeedNotifications.openView();
		const generation = FeedNotifications.handleFetchPending();
		FeedNotifications.lastReadAt = 2000;
		persistence.onRehydrated();
		FeedNotifications.handleFetchSuccess(generation, [wireNotification(1)], true);
		expect(FeedNotifications.notifications).toEqual([]);
		expect(FeedNotifications.serverUnread).toBeNull();
		expect(FeedNotifications.lastReadAt).toBe(2000);
		expect(FeedNotifications.closeView()).toBeNull();
		FeedNotifications.handleGatewayReady(
			{last_read_at: null, unread_count: 2, unread_seq: 1, unread_epoch: 8},
			'same-user',
		);
		expect(FeedNotifications.closeView()).toBeNull();
	});

	it('counts a pushed notification as unread', () => {
		expect(FeedNotifications.unreadCount).toBe(0);
		handleFeedNotificationCreate({...wireNotification(1), unread_seq: 1, unread_epoch: 0}, {} as never);
		expect(FeedNotifications.unreadCount).toBe(1);
		expect(ids()).toEqual(['1']);
	});

	it('keeps source rows, server count and failed read when begin promotion fails before changing scope', async () => {
		const cursor = Date.parse(wireNotification(2).updated_at);
		FeedNotifications.handleGatewayReady(
			{last_read_at: new Date(cursor).toISOString(), unread_count: 3, unread_seq: 5, unread_epoch: 7},
			'source',
		);
		FeedNotifications.handleNotificationCreate(wireNotification(1), 5, 7);
		const retry = {readAt: cursor, seq: 5, epoch: 7};
		FeedNotifications.handleReadFailure(retry);
		const stalePage = FeedNotifications.handleFetchPending();
		const failure = new Error('begin promotion failed');
		const unexpectedStep = (): never => {
			throw new Error('Unexpected promotion step after begin failure');
		};
		const host: ForegroundPromoteHost = {
			findWarmCandidate: () => {
				throw failure;
			},
			prepareForegroundSnapshot: unexpectedStep,
			hydrateForegroundSnapshot: unexpectedStep,
			commitForegroundSnapshot: unexpectedStep,
			abortForegroundSnapshot: unexpectedStep,
			finalizeForegroundSnapshot: unexpectedStep,
			stopBackgroundConnection: unexpectedStep,
			prepareForegroundReplay: unexpectedStep,
			adoptForegroundSocket: unexpectedStep,
			replayForegroundDispatch: unexpectedStep,
			finalizeForeground: unexpectedStep,
			removeBackgroundConnection: unexpectedStep,
			discardDetachedSocket: unexpectedStep,
			discardForegroundConnection: unexpectedStep,
		};
		const coordinator = new ForegroundPromoteCoordinator(host);
		await expect(
			AccountScopedWork.runSuspended(AccountScopedWorkTransitionReason.ACCOUNT_SWITCH, async () => {
				await coordinator.begin('https://second.test/api::source');
			}),
		).rejects.toBe(failure);
		expect(ids()).toEqual(['1']);
		expect(FeedNotifications.serverUnread).toBe(3);
		expect(FeedNotifications.unreadCount).toBe(3);
		expect(FeedNotifications.lastReadAt).toBe(cursor);
		expect(FeedNotifications.lastReadUserId).toBe('source');
		expect(FeedNotifications.isLoading).toBe(false);
		FeedNotifications.handleFetchSuccess(stalePage, page(99, 2), true);
		expect(ids()).toEqual(['1']);
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toEqual(retry);
		FeedNotifications.reset();
	});

	it('updates a notification the server folded more actors into in place, without a second row', () => {
		FeedNotifications.handleNotificationCreate(wireNotification(2));
		FeedNotifications.handleNotificationCreate(wireNotification(1));
		FeedNotifications.handleNotificationCreate(
			wireNotification(1, {
				actors: [wireUser('9'), wireUser('7')],
				actor_count: 40,
				updated_at: '2030-01-01T00:00:00.000Z',
			}),
		);
		expect(ids()).toEqual(['2', '1']);
		expect(FeedNotifications.notifications[1]?.actorCount).toBe(40);
		expect(FeedNotifications.notifications[1]?.actors.map((actor) => actor.id)).toEqual(['9', '7']);
		expect(FeedNotifications.unreadCount).toBe(2);
	});

	it('orders a newer pushed notification above the loaded ones', () => {
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(20, 3), true);
		FeedNotifications.handleNotificationCreate(wireNotification(30));
		expect(ids()).toEqual(['30', '20', '19', '18']);
	});

	it('shows nothing unread while the activity tab is open and marks everything seen read when it closes', () => {
		FeedNotifications.handleNotificationCreate(wireNotification(1));
		FeedNotifications.openView();
		expect(FeedNotifications.unreadCount).toBe(0);
		FeedNotifications.handleNotificationCreate(wireNotification(2));
		expect(FeedNotifications.unreadCount).toBe(0);
		expect(FeedNotifications.isUnread(FeedNotifications.notifications[0]!)).toBe(true);
		FeedNotifications.closeView();
		expect(FeedNotifications.unreadCount).toBe(0);
		expect(FeedNotifications.lastReadAt).toBe(Date.parse(wireNotification(2).updated_at));
		FeedNotifications.handleNotificationCreate(wireNotification(3));
		expect(FeedNotifications.unreadCount).toBe(1);
	});

	it('counts a read notification as unread again when a new actor is folded into it', () => {
		FeedNotifications.handleNotificationCreate(wireNotification(1));
		FeedNotifications.openView();
		FeedNotifications.closeView();
		expect(FeedNotifications.unreadCount).toBe(0);
		FeedNotifications.handleNotificationCreate(
			wireNotification(1, {actor_count: 2, updated_at: '2030-01-01T00:00:00.000Z'}),
		);
		expect(FeedNotifications.unreadCount).toBe(1);
		expect(FeedNotifications.notifications).toHaveLength(1);
	});

	it('pages back with the oldest loaded id as the cursor and stops at an empty page', () => {
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(100, 25), true);
		expect(FeedNotifications.getCursor()).toBe('76');
		expect(FeedNotifications.canLoadMore).toBe(true);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(75, 5), false);
		expect(FeedNotifications.notifications).toHaveLength(30);
		expect(FeedNotifications.getCursor()).toBe('71');
		// A short page is not the end: the server pages across time buckets.
		expect(FeedNotifications.canLoadMore).toBe(true);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), [], false);
		expect(FeedNotifications.canLoadMore).toBe(false);
	});

	it('restarts from the newest page, dropping what was loaded before', () => {
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(100, 25), true);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(75, 25), false);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(110, 2), true);
		expect(ids()).toEqual(['110', '109']);
	});

	it('keeps at most 200 rows in memory and stops paging there', () => {
		const pending = () => FeedNotifications.handleFetchPending();
		FeedNotifications.handleFetchSuccess(pending(), page(1000, 50), true);
		for (let from = 950; FeedNotifications.notifications.length < MAX_LOADED_FEED_NOTIFICATIONS; from -= 50) {
			FeedNotifications.handleFetchSuccess(pending(), page(from, 50), false);
		}
		expect(FeedNotifications.notifications).toHaveLength(MAX_LOADED_FEED_NOTIFICATIONS);
		expect(FeedNotifications.canLoadMore).toBe(false);
		FeedNotifications.handleNotificationCreate(wireNotification(2000));
		expect(FeedNotifications.notifications).toHaveLength(MAX_LOADED_FEED_NOTIFICATIONS);
		expect(FeedNotifications.notifications[0]?.id).toBe('2000');
		expect(FeedNotifications.notifications.at(-1)?.id).toBe('802');
	});

	it('ignores a page from a request that a newer one replaced', () => {
		const stale = FeedNotifications.handleFetchPending();
		const current = FeedNotifications.handleFetchPending();
		FeedNotifications.handleFetchSuccess(current, page(10, 2), true);
		FeedNotifications.handleFetchSuccess(stale, page(99, 2), true);
		expect(ids()).toEqual(['10', '9']);
		expect(FeedNotifications.isLoading).toBe(false);
	});

	it('forgets the loaded rows on a new gateway session, as another account may be signed in', () => {
		FeedNotifications.handleNotificationCreate(wireNotification(1));
		FeedNotifications.handleGatewayReady();
		expect(FeedNotifications.notifications).toHaveLength(0);
		expect(FeedNotifications.unreadCount).toBe(0);
		expect(FeedNotifications.fetched).toBe(false);
	});

	// A newer server may send a type this build has no icon or text for.
	const unknownType = (id: number) => wireNotification(id, {type: 'post_mention' as never});

	it('drops notification types it does not know from a page and from a push', () => {
		FeedNotifications.handleFetchSuccess(
			FeedNotifications.handleFetchPending(),
			[wireNotification(3), unknownType(2), wireNotification(1)],
			true,
		);
		expect(ids()).toEqual(['3', '1']);
		handleFeedNotificationCreate({...unknownType(4), unread_seq: 1, unread_epoch: 0}, {} as never);
		expect(ids()).toEqual(['3', '1']);
		expect(FeedNotifications.unreadCount).toBe(2);
	});

	it('pages on past the rows it dropped, so a page of unknown types does not stop the list', () => {
		FeedNotifications.handleFetchSuccess(
			FeedNotifications.handleFetchPending(),
			[wireNotification(10), unknownType(9)],
			true,
		);
		expect(FeedNotifications.getCursor()).toBe('9');
		FeedNotifications.handleFetchSuccess(
			FeedNotifications.handleFetchPending(),
			[unknownType(8), unknownType(7)],
			false,
		);
		expect(FeedNotifications.getCursor()).toBe('7');
		expect(FeedNotifications.canLoadMore).toBe(true);
		expect(ids()).toEqual(['10']);
	});
});

describe('FeedActivityContent', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		FeedNotifications.handleGatewayReady();
		modalCommands.push.mockClear();
		// Like the real command, closing ends the view in the store, so no open view leaks into the next tests.
		feedNotificationCommands.markRead.mockReset().mockImplementation(async () => void FeedNotifications.closeView());
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('renders a comment_reply row and opens the post with comments', () => {
		FeedNotifications.handleNotificationCreate(wireNotification(1, {type: 'comment_reply', comment_id: '600'}));
		act(() => root.render(createElement(FeedActivityContent)));
		const row = container.querySelector('button');
		expect(row?.textContent).toContain('user7 replied to your comment.');
		act(() => row!.click());
		expect(modalCommands.push).toHaveBeenCalledTimes(1);
		const renderModal = modalCommands.push.mock.calls[0]![0] as () => ReactElement<Record<string, unknown>>;
		expect(renderModal().props).toMatchObject({postId: '500', showComments: true});
	});

	// Closing the view (the popout, the Notifications page, the phone sheet once it unmounts) marks it read on the server.
	it("caps the activity tab's badge at 9+ like the feed's inbox button (2a.9b)", () => {
		FeedNotifications.lastReadAt = 0;
		FeedNotifications.handleNotificationCreate(wireNotification(1));
		act(() => root.render(createElement(FeedActivityTabIcon)));
		const count = container.querySelector('[data-max]');
		expect(count?.textContent).toBe('1');
		expect(count?.getAttribute('data-max')).toBe('9');
	});

	it('marks what it showed read when it closes (2a.9b)', () => {
		act(() => root.render(createElement(FeedActivityContent)));
		expect(feedNotificationCommands.markRead).not.toHaveBeenCalled();
		act(() => root.render(null));
		expect(feedNotificationCommands.markRead).toHaveBeenCalledTimes(1);
	});
});

describe('FeedNotifications server unread state (2a.9b)', () => {
	const state = (fields: Partial<FeedNotificationStateResponse> = {}): FeedNotificationStateResponse => ({
		last_read_at: '2027-01-15T08:00:00.000Z',
		unread_count: 3,
		unread_seq: 5,
		unread_epoch: 100,
		...fields,
	});
	const ack = (fields: Partial<FeedNotificationAckResponse> = {}): FeedNotificationAckResponse => ({
		last_read_at: '2027-01-15T09:00:00.000Z',
		unread_seq: 5,
		unread_epoch: 100,
		...fields,
	});
	let accounts = 0;
	let userId = '';

	// Each test runs as a new account on this device, so no server state of the previous test carries over.
	beforeEach(() => {
		userId = `account-${++accounts}`;
		FeedNotifications.handleGatewayReady(undefined, userId);
		FeedNotifications.lastReadAt = 0;
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('takes the count and cursor from READY and caps the badge at 10 (C1-T1, T2)', () => {
		FeedNotifications.handleGatewayReady(state(), userId);
		expect(FeedNotifications.unreadCount).toBe(3);
		expect(FeedNotifications.lastReadAt).toBe(Date.parse('2027-01-15T08:00:00.000Z'));
		FeedNotifications.handleGatewayReady(state({unread_count: 10}), userId);
		expect(FeedNotifications.unreadCount).toBe(10);
	});

	it('adds the rise of the unread sequence once, whatever order pushes come in (C1-T3)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 2, unread_seq: 5}), userId);
		FeedNotifications.handleNotificationCreate(wireNotification(1), 5);
		expect(FeedNotifications.unreadCount).toBe(2);
		FeedNotifications.handleNotificationCreate(wireNotification(2), 7);
		expect(FeedNotifications.unreadCount).toBe(4);
		FeedNotifications.handleNotificationCreate(wireNotification(2), 7);
		FeedNotifications.handleNotificationCreate(wireNotification(1), 6);
		expect(FeedNotifications.unreadCount).toBe(4);
		for (let seq = 8; seq < 20; seq++) FeedNotifications.handleNotificationCreate(wireNotification(seq), seq);
		expect(FeedNotifications.unreadCount).toBe(10);
	});

	it('reads on close what the view showed and what the loaded list left out (denetim O4, C1-T4)', () => {
		FeedNotifications.handleGatewayReady(state({last_read_at: null, unread_count: 2, unread_seq: 2}), userId);
		FeedNotifications.openView();
		expect(FeedNotifications.unreadCount).toBe(0);
		// Nothing loaded (the list failed or is still loading): nothing was seen, the count stays.
		expect(FeedNotifications.closeView()).toBeNull();
		expect(FeedNotifications.unreadCount).toBe(2);
		// The newest page loaded empty (its rows point at deleted posts): the badge clears, read up to the server's
		// time of the list; the device clock (far ahead here) is never used.
		vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), [], true, 1_850_000_000_000);
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toEqual({readAt: 1_850_000_000_000, seq: 2, epoch: 100});
		expect(FeedNotifications.unreadCount).toBe(0);
		// The list's time goes to the server, which clamps it; it is never kept as the cursor.
		expect(FeedNotifications.lastReadAt).toBe(0);
	});

	it('reads on close on a session that counts on the device too (denetim O3, C1-T4b)', () => {
		FeedNotifications.handleNotificationCreate(wireNotification(1));
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toEqual({
			readAt: Date.parse(wireNotification(1).updated_at),
			seq: 0,
			epoch: 0,
		});
	});

	it('takes a read from any session without raising the count; twice is once (C1-T5)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 4, unread_seq: 9}), userId);
		const read = ack({unread_seq: 9});
		FeedNotifications.handleAck(read);
		FeedNotifications.handleAck(read);
		expect(FeedNotifications.unreadCount).toBe(0);
		expect(FeedNotifications.lastReadAt).toBe(Date.parse(read.last_read_at));
		// A late read from a device that saw less takes neither the cursor back nor the count up.
		FeedNotifications.handleAck(ack({last_read_at: '2027-01-15T07:00:00.000Z', unread_seq: 3}));
		expect(FeedNotifications.unreadCount).toBe(0);
		expect(FeedNotifications.lastReadAt).toBe(Date.parse(read.last_read_at));
		FeedNotifications.handleNotificationCreate(wireNotification(5000), 10);
		expect(FeedNotifications.unreadCount).toBe(1);
	});

	it("counts on the device on an account's first READY without state, or with no server cursor while the device kept one (C1-T6, T7)", () => {
		FeedNotifications.handleNotificationCreate(wireNotification(1), 3);
		expect(FeedNotifications.unreadCount).toBe(1);
		FeedNotifications.lastReadAt = Date.parse(wireNotification(1).updated_at);
		FeedNotifications.handleGatewayReady(state({last_read_at: null, unread_count: 10, unread_seq: 3}), userId);
		expect(FeedNotifications.serverUnread).toBeNull();
		expect(FeedNotifications.unreadCount).toBe(0);
		FeedNotifications.handleNotificationCreate(wireNotification(2), 4);
		expect(FeedNotifications.unreadCount).toBe(1);
	});

	it('keeps the server count through a READY that came without state (denetim Y2, C1-T8)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 3, unread_seq: 5}), userId);
		FeedNotifications.handleGatewayReady(undefined, userId);
		expect(FeedNotifications.unreadCount).toBe(3);
		FeedNotifications.handleNotificationCreate(wireNotification(1), 6);
		expect(FeedNotifications.unreadCount).toBe(4);
	});

	it('carries nothing over to another account on this device (denetim O6, C1-T9)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 3, unread_seq: 5}), userId);
		FeedNotifications.handleGatewayReady(undefined, 'another-account');
		expect(FeedNotifications.serverUnread).toBeNull();
		expect(FeedNotifications.unreadCount).toBe(0);
		expect(FeedNotifications.lastReadAt).toBe(0);
		expect(FeedNotifications.lastReadUserId).toBe('another-account');
	});

	it('keeps a push that came after the read it answers (denetim Y3, C1-T10)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 1, unread_seq: 4}), userId);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(20, 1), true);
		FeedNotifications.openView();
		const read = FeedNotifications.closeView()!;
		expect(read.seq).toBe(4);
		// Pushed after the close, before the answer: the answer covers 4, so 5 stays unread.
		FeedNotifications.handleNotificationCreate(wireNotification(30), 5);
		FeedNotifications.handleAck(ack({last_read_at: new Date(read.readAt).toISOString(), unread_seq: 4}));
		expect(FeedNotifications.unreadCount).toBe(1);
	});

	it('starts again from 0 under a later unread epoch and ignores an earlier one (D1)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 2, unread_seq: 57, unread_epoch: 100}), userId);
		// The hash expired after a quiet day; its new sequence starts at 1.
		FeedNotifications.handleNotificationCreate(wireNotification(1), 1, 200);
		expect(FeedNotifications.unreadCount).toBe(3);
		// A late push of the old sequence adds nothing and does not move the base.
		FeedNotifications.handleNotificationCreate(wireNotification(2), 58, 100);
		expect(FeedNotifications.unreadCount).toBe(3);
		FeedNotifications.handleNotificationCreate(wireNotification(3), 2, 200);
		expect(FeedNotifications.unreadCount).toBe(4);
		// A read under the new epoch covers what it says; one under the old epoch reads none of the new sequence.
		FeedNotifications.handleAck(ack({unread_seq: 1, unread_epoch: 100}));
		expect(FeedNotifications.unreadCount).toBe(4);
		FeedNotifications.handleAck(ack({unread_seq: 1, unread_epoch: 200}));
		expect(FeedNotifications.unreadCount).toBe(1);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), [], true, 1_850_000_000_000);
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toMatchObject({seq: 2, epoch: 200});
	});

	it('takes the base of a read under a later epoch than the session knew (D1)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 3, unread_seq: 57, unread_epoch: 100}), userId);
		FeedNotifications.handleAck(ack({last_read_at: '2027-01-16T00:00:00.000Z', unread_seq: 0, unread_epoch: 300}));
		expect(FeedNotifications.unreadCount).toBe(0);
		FeedNotifications.handleNotificationCreate(wireNotification(500_000), 1, 300);
		expect(FeedNotifications.unreadCount).toBe(1);
	});

	it('does not light the badge again for a held push of a row read already (D3)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 1, unread_seq: 4}), userId);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(20, 1), true);
		FeedNotifications.openView();
		const read = FeedNotifications.closeView()!;
		FeedNotifications.handleAck(ack({last_read_at: new Date(read.readAt).toISOString(), unread_seq: 4}));
		expect(FeedNotifications.unreadCount).toBe(0);
		// The row the view showed, pushed late with the sequence its job raised: read already, so only the base moves.
		FeedNotifications.handleNotificationCreate(wireNotification(20), 5);
		expect(FeedNotifications.unreadCount).toBe(0);
		FeedNotifications.handleNotificationCreate(wireNotification(21), 6);
		expect(FeedNotifications.unreadCount).toBe(1);
	});

	it('pulls the base down to READY after a higher push, and the next push brings the missed one (D4 i)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 1, unread_seq: 5}), userId);
		FeedNotifications.handleNotificationCreate(wireNotification(1), 9);
		expect(FeedNotifications.unreadCount).toBe(5);
		// A READY counted before the pushes 7-9 were made: its base, not the higher one.
		FeedNotifications.handleGatewayReady(state({unread_count: 2, unread_seq: 6}), userId);
		expect(FeedNotifications.unreadCount).toBe(2);
		FeedNotifications.handleNotificationCreate(wireNotification(2), 7);
		expect(FeedNotifications.unreadCount).toBe(3);
	});

	it('keeps a read that came before the READY it is newer than (D4 ii)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 3, unread_seq: 5}), userId);
		FeedNotifications.handleAck(ack({last_read_at: '2027-01-15T09:00:00.000Z', unread_seq: 5}));
		expect(FeedNotifications.unreadCount).toBe(0);
		// READY read the cursor before that read reached the server.
		FeedNotifications.handleGatewayReady(state({unread_count: 3, unread_seq: 5}), userId);
		expect(FeedNotifications.unreadCount).toBe(0);
		expect(FeedNotifications.lastReadAt).toBe(Date.parse('2027-01-15T09:00:00.000Z'));
		// A READY that already has it changes nothing.
		FeedNotifications.handleGatewayReady(state({last_read_at: '2027-01-15T09:00:00.000Z', unread_count: 0}), userId);
		expect(FeedNotifications.unreadCount).toBe(0);
		// Another account on this device takes nothing of it.
		FeedNotifications.handleGatewayReady(state({unread_count: 3, unread_seq: 5}), 'another-account');
		expect(FeedNotifications.unreadCount).toBe(3);
	});

	it('sends a read again on the next close when it could not be sent (D5)', () => {
		FeedNotifications.handleGatewayReady(state({unread_count: 1, unread_seq: 4}), userId);
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), page(20, 1), true);
		FeedNotifications.openView();
		const read = FeedNotifications.closeView()!;
		FeedNotifications.handleReadFailure(read);
		// Nothing new on screen: the failed read goes again.
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toEqual(read);
		// Sent: it does not go a third time.
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toBeNull();
		// Another account on this device does not send it.
		FeedNotifications.handleReadFailure(read);
		FeedNotifications.handleGatewayReady(undefined, 'another-account');
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toBeNull();
	});

	it('reads up to the newest row of the list, an unknown type included, without the server time (D6)', () => {
		FeedNotifications.handleGatewayReady(state({last_read_at: null, unread_count: 2, unread_seq: 2}), userId);
		vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
		const unknown = wireNotification(40, {type: 'post_mention' as never});
		FeedNotifications.handleFetchSuccess(FeedNotifications.handleFetchPending(), [unknown, wireNotification(10)], true);
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toMatchObject({readAt: Date.parse(unknown.updated_at)});
	});

	it('tracks the sequence on a session that counts on the device too (D9)', () => {
		FeedNotifications.lastReadAt = 1;
		FeedNotifications.handleGatewayReady(state({last_read_at: null, unread_count: 0, unread_seq: 3}), userId);
		expect(FeedNotifications.serverUnread).toBeNull();
		FeedNotifications.handleNotificationCreate(wireNotification(1), 4);
		FeedNotifications.openView();
		expect(FeedNotifications.closeView()).toMatchObject({seq: 4, epoch: 100});
	});
});
