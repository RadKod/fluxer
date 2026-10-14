// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({featureFeed: 1}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({
	LimitResolver: {
		resolve: ({key, fallback}: {key: string; fallback: number}) =>
			key === 'feature_feed' ? state.featureFeed : fallback,
	},
}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({MENTIONS_DESCRIPTOR: {message: 'Mentions'}}));
vi.mock('@app/features/app/hooks/useSkeletonLayoutMemoryCapture', () => ({useSkeletonLayoutReport: () => {}}));
vi.mock('@app/features/app/components/skeleton/SkeletonLayoutMemory', () => ({
	reportSkeletonSimplePageLayout: () => {},
	SkeletonSimplePageBody: {CHANNEL_LIST: 'channel_list', MESSAGE_LIST: 'message_list'},
	SkeletonSimplePageRoute: {NOTIFICATIONS: 'notifications'},
}));
vi.mock('@app/features/notification/state/MentionFeed', () => ({default: {getAccessibleMentions: () => []}}));
vi.mock('@app/features/inbox/state/FeedNotifications', () => ({default: {notifications: []}}));
vi.mock('@app/features/app/components/floating/UnreadChannelsContent', () => ({
	getUnreadChannels: () => [],
	UnreadChannelsContent: () => createElement('p', null, 'unread channels'),
}));
vi.mock('@app/features/messaging/components/popouts/RecentMentionsContent', () => ({
	RecentMentionsContent: () => createElement('p', null, 'mentions'),
}));
vi.mock('@app/features/inbox/components/FeedActivityContent', () => ({
	FeedActivityContent: () => createElement('p', null, 'feed activity'),
}));
vi.mock('@app/features/ui/components/form/FormCombobox', () => ({
	Combobox: ({
		value,
		options,
		onChange,
	}: {
		value: string;
		options: Array<{label: string; value: string}>;
		onChange: (value: string) => void;
	}) =>
		createElement(
			'select',
			{value, onChange: (event: {target: {value: string}}) => onChange(event.target.value)},
			options.map((option) => createElement('option', {key: option.value, value: option.value}, option.label)),
		),
}));

const {NotificationsPage} = await import('@app/features/notification/components/pages/NotificationsPage');

describe('NotificationsPage activity filter', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.featureFeed = 1;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = () => act(() => root.render(createElement(NotificationsPage, {onBookmarksClick: () => {}})));
	const filterLabels = () => Array.from(container.querySelectorAll('option')).map((option) => option.textContent);
	const pickFilter = (value: string) =>
		act(() => {
			const select = container.querySelector('select')!;
			select.value = value;
			select.dispatchEvent(new Event('change', {bubbles: true}));
		});

	it('offers the activity filter and shows the feed notifications in it', () => {
		render();
		expect(filterLabels()).toEqual(['Unreads', 'Mentions', 'Activity']);
		pickFilter('activity');
		expect(container.textContent).toContain('feed activity');
		expect(container.textContent).not.toContain('unread channels');
	});

	it('has no activity filter when the feed is off (feature_feed = 0)', () => {
		state.featureFeed = 0;
		render();
		expect(filterLabels()).toEqual(['Unreads', 'Mentions']);
		expect(container.textContent).toContain('unread channels');
	});
});
