// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({featureFeed: 1, selectedTab: 'bookmarks'}));

const passthrough = ({children}: {children: unknown}) => children;

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {
		resolve: ({key, fallback}: {key: string; fallback: number}) =>
			key === 'feature_feed' ? state.featureFeed : fallback,
	},
}));
vi.mock('@app/features/inbox/state/Inbox', () => ({
	default: {
		get selectedTab() {
			return state.selectedTab;
		},
	},
}));
vi.mock('@app/features/inbox/commands/InboxCommands', () => ({setTab: vi.fn(), markAllInboxChannelsAsRead: vi.fn()}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({MENTIONS_DESCRIPTOR: {message: 'Mentions'}}));
vi.mock('@app/features/app/components/floating/UnreadChannelsContent', () => ({
	getMarkableUnreadChannels: () => [],
	UnreadChannelsContent: () => createElement('p', null, 'unread channels'),
}));
vi.mock('@app/features/messaging/components/popouts/RecentMentionsContent', () => ({
	RecentMentionsContent: () => null,
}));
vi.mock('@app/features/messaging/components/popouts/SavedMessagesContent', () => ({SavedMessagesContent: () => null}));
vi.mock('@app/features/inbox/components/FeedActivityContent', () => ({
	FeedActivityContent: () => createElement('p', null, 'feed activity'),
	FeedActivityTabIcon: () => null,
}));
vi.mock('@app/features/read_state/state/ReadStates', () => ({default: {version: 0}}));
vi.mock('@app/features/user/state/UserGuildSettings', () => ({default: {version: 0}}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: passthrough}));
vi.mock('@app/features/ui/focus_ring/FocusRingScope', () => ({default: passthrough}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: passthrough}));
vi.mock('@app/features/ui/hooks/useResizablePane', () => ({
	RESIZABLE_PANE_DEFAULT_VIEWPORT_PADDING: 0,
	useResizablePane: () => ({size: {width: 600, height: 900}, getHandleProps: () => ({})}),
}));
vi.mock('@app/features/ui/resizable_pane/ResizablePaneHandles', () => ({ResizablePaneHandles: () => null}));

const {InboxPopout} = await import('@app/features/messaging/components/popouts/InboxPopout');

describe('InboxPopout activity tab', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.featureFeed = 1;
		state.selectedTab = 'bookmarks';
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = () => act(() => root.render(createElement(InboxPopout)));
	const activityTab = () => container.querySelector('button[role="tab"]#activity');

	it('offers the activity tab and shows the feed notifications in it', () => {
		state.selectedTab = 'activity';
		render();
		expect(activityTab()?.getAttribute('aria-label')).toBe('Activity');
		expect(activityTab()?.getAttribute('aria-selected')).toBe('true');
		expect(container.querySelector('#inbox-panel-activity')?.textContent).toBe('feed activity');
	});

	it('has no activity tab when the feed is off (feature_feed = 0), even if it was the last one open', () => {
		state.featureFeed = 0;
		state.selectedTab = 'activity';
		render();
		expect(activityTab()).toBeNull();
		expect(container.querySelector('#inbox-panel-activity')).toBeNull();
		expect(container.querySelector('#inbox-panel-unreadChannels')?.textContent).toBe('unread channels');
	});
});
