// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runInAction} from 'mobx';
import {act, createElement, forwardRef, type ReactElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({INBOX_DESCRIPTOR: {message: 'Inbox'}}));
const inboxCommands = vi.hoisted(() => ({setTab: vi.fn()}));
vi.mock('@app/features/inbox/commands/InboxCommands', () => inboxCommands);
vi.mock('@app/features/inbox/state/FeedNotifications', async () => ({
	default: (await import('mobx')).observable({unreadCount: 0}),
}));
const mentions = await vi.hoisted(async () => (await import('mobx')).observable.box(0));
vi.mock('@app/features/guild/state/GuildReadState', () => ({
	default: {mentionCountAcrossGuilds: () => mentions.get()},
}));
vi.mock('@app/features/feed/utils/FeedUtils', () => ({isFeedEnabled: () => true}));
vi.mock('@app/features/ui/components/MentionBadge', () => ({
	MentionBadge: ({mentionCount, max}: {mentionCount: number; max?: number}) =>
		createElement('span', {'data-max': max}, String(mentionCount)),
}));
const feedNotificationCommands = vi.hoisted(() => ({markRead: vi.fn()}));
vi.mock('@app/features/inbox/commands/FeedNotificationCommands', () => feedNotificationCommands);
// usePopout only reads this map; the Popout mock below handles opening without loading unrelated app stores.
vi.mock('@app/features/ui/state/Popout', async () => ({
	default: (await import('mobx')).observable({popouts: {}}),
}));
vi.mock('@app/features/ui/state/MobileLayout', async () => ({
	default: (await import('mobx')).observable({
		enabled: false,
		isMobileLayout() {
			return this.enabled;
		},
	}),
}));
// Like the real icon: the label names the button and the other props (the popout's trigger props) go on it.
vi.mock('@app/features/channel/components/channel_header_components/ChannelHeaderIcon', () => ({
	ChannelHeaderIcon: forwardRef<
		HTMLButtonElement,
		{label: string; icon: unknown; isSelected?: boolean; keybindAction?: string}
	>(({label, icon: _icon, isSelected: _isSelected, keybindAction, ...rest}, ref) =>
		createElement('button', {...rest, ref, type: 'button', 'aria-label': label, 'data-keybind': keybindAction}),
	),
}));
// Popout's contract (the real one loads the app's stores): the child is cloned with the trigger props and the ref (the
// target, where focus returns), a click or the subscribed ComponentBus event toggles it, and onOpen runs on opening.
const openedPopouts = vi.hoisted(() => [] as Array<{key: string; target: HTMLElement | null; render: () => ReactNode}>);
vi.mock('@app/features/ui/popover/PopoverPopout', async () => {
	const {cloneElement, useEffect, useRef, useState} = await import('react');
	const {ComponentBus} = await import('@app/features/platform/utils/ComponentBus');
	return {
		Popout: ({
			uniqueId,
			render,
			onOpen,
			subscribeTo,
			children,
		}: {
			uniqueId: string;
			render: () => ReactNode;
			onOpen?: () => void;
			subscribeTo?: 'INBOX_OPEN';
			children: ReactElement<Record<string, unknown>>;
		}) => {
			const [isOpen, setIsOpen] = useState(false);
			const target = useRef<HTMLElement>(null);
			const toggle = () => {
				if (!isOpen) {
					onOpen?.();
					openedPopouts.push({key: uniqueId, target: target.current, render});
				}
				setIsOpen(!isOpen);
			};
			useEffect(() => {
				if (!subscribeTo) return;
				ComponentBus.subscribe(subscribeTo, toggle);
				return () => ComponentBus.unsubscribe(subscribeTo, toggle);
			});
			return cloneElement(children, {'aria-expanded': isOpen, onClick: toggle, ref: target});
		},
	};
});
vi.mock('@app/features/messaging/components/popouts/InboxPopout', () => ({
	InboxPopout: () => createElement('div', {'data-testid': 'inbox-popout'}),
}));
// Like the real list (FeedNotifications.test.ts): unmounting it marks what it showed read.
vi.mock('@app/features/inbox/components/FeedActivityContent', async () => {
	const {useEffect} = await import('react');
	return {
		FeedActivityContent: () => {
			useEffect(() => () => void feedNotificationCommands.markRead(), []);
			return createElement('div', {'data-testid': 'feed-activity'});
		},
	};
});
// Like Sheet.Root, which unmounts its content once closed (after its close animation; here at once), with the close
// button of BottomSheet's header.
vi.mock('@app/features/ui/bottom_sheet/BottomSheet', () => ({
	BottomSheet: ({
		isOpen,
		onClose,
		title,
		children,
	}: {
		isOpen: boolean;
		onClose: () => void;
		title?: string;
		children: ReactNode;
	}) =>
		isOpen
			? createElement(
					'div',
					{role: 'dialog', 'aria-label': title},
					createElement('button', {type: 'button', 'aria-label': 'Close', onClick: onClose}),
					children,
				)
			: null,
}));
const {default: FeedNotifications} = await import('@app/features/inbox/state/FeedNotifications');
const {default: MobileLayout} = await import('@app/features/ui/state/MobileLayout');
const {ComponentBus} = await import('@app/features/platform/utils/ComponentBus');
const {InboxPopout} = await import('@app/features/messaging/components/popouts/InboxPopout');
const {FeedNotificationsButton} = await import('@app/features/feed/components/FeedNotificationsButton');

describe('FeedNotificationsButton', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const button = () => container.querySelector('button')!;
	const badge = () => container.querySelector('[data-flx="feed.feed-notifications-button.unread-badge"]');
	const setUnread = (count: number) =>
		act(() => runInAction(() => ((FeedNotifications as {unreadCount: number}).unreadCount = count)));
	const setMentions = (count: number) => act(() => runInAction(() => mentions.set(count)));
	const render = () => act(() => root.render(createElement(FeedNotificationsButton)));

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		runInAction(() => {
			(FeedNotifications as {unreadCount: number}).unreadCount = 0;
			(MobileLayout as {enabled: boolean}).enabled = false;
			mentions.set(0);
		});
		inboxCommands.setTab.mockClear();
		openedPopouts.length = 0;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	it('shows no badge and says only Inbox while nothing is unread', () => {
		render();
		expect(badge()).toBeNull();
		expect(button().getAttribute('aria-label')).toBe('Inbox');
	});

	// The server counts (READY and the unread sequence), so the badge is a number now, capped at "9+".
	it('shows the unread count, capped at 9+, beside the button and says unread', () => {
		render();
		setUnread(3);
		expect(badge()!.getAttribute('aria-hidden')).toBe('true');
		expect(badge()!.textContent).toBe('3');
		expect(button().getAttribute('aria-label')).toBe('Inbox, unread');
		expect(badge()!.parentElement).toBe(button().parentElement);
		setUnread(10);
		expect(badge()!.querySelector('[data-max]')!.getAttribute('data-max')).toBe('9');
		setUnread(0);
		expect(badge()).toBeNull();
	});

	// The popout is the channel header's inbox, so the badge is the channel header's: unread mentions plus activity.
	it('shows the same count as the channel header inbox button on the desktop layout', () => {
		render();
		setMentions(2);
		expect(badge()!.textContent).toBe('2');
		setUnread(3);
		expect(badge()!.textContent).toBe('5');
		expect(badge()!.querySelector('[data-max]')!.getAttribute('data-max')).toBe('99');
		expect(button().getAttribute('aria-label')).toBe('Inbox, unread');
	});

	it('counts only the activity on the phone layout, whose sheet lists only that', () => {
		runInAction(() => ((MobileLayout as {enabled: boolean}).enabled = true));
		render();
		setMentions(2);
		expect(badge()).toBeNull();
		setUnread(3);
		expect(badge()!.textContent).toBe('3');
		expect(badge()!.querySelector('[data-max]')!.getAttribute('data-max')).toBe('9');
	});

	// The popout's trigger is the button itself (aria-expanded, focus return), with the badge beside it in the wrapper.
	it('opens the inbox popout on its activity tab from the button on the desktop layout', () => {
		render();
		setUnread(1);
		expect(badge()!.parentElement).toBe(button().parentElement);
		expect(button().getAttribute('aria-expanded')).toBe('false');
		act(() => button().click());
		expect(inboxCommands.setTab).toHaveBeenCalledWith('activity');
		expect(button().getAttribute('aria-expanded')).toBe('true');
		expect(container.querySelectorAll('[aria-expanded]')).toHaveLength(1);
		expect(openedPopouts).toHaveLength(1);
		const [popout] = openedPopouts;
		expect(popout!.key).toBe('inbox');
		expect(popout!.target).toBe(button());
		expect((popout!.render() as ReactElement).type).toBe(InboxPopout);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
	});

	// Mentions in a DM have no row on the Mentions tab, so with only mentions unread it opens on the Unread tab.
	it('opens on the unread channels tab when only mentions are unread', () => {
		render();
		setMentions(2);
		act(() => button().click());
		expect(inboxCommands.setTab).toHaveBeenLastCalledWith('unreadChannels');
		act(() => button().click());
		setUnread(3);
		act(() => button().click());
		expect(inboxCommands.setTab).toHaveBeenLastCalledWith('activity');
	});

	it("opens on the channel header's inbox keybind, on the activity tab", () => {
		render();
		expect(button().getAttribute('data-keybind')).toBe('chat_toggle_inbox');
		act(() => ComponentBus.dispatch('INBOX_OPEN'));
		expect(inboxCommands.setTab).toHaveBeenCalledWith('activity');
		expect(openedPopouts.map((popout) => popout.key)).toEqual(['inbox']);
		expect(button().getAttribute('aria-expanded')).toBe('true');
	});

	it('opens the activity list in a bottom sheet on the phone layout', () => {
		runInAction(() => ((MobileLayout as {enabled: boolean}).enabled = true));
		render();
		expect(ComponentBus.hasSubscribers('INBOX_OPEN')).toBe(false);
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		act(() => button().click());
		const sheet = container.querySelector('[role="dialog"]')!;
		expect(sheet.getAttribute('aria-label')).toBe('Activity');
		expect(sheet.querySelector('[data-testid="feed-activity"]')).not.toBeNull();
		expect(button().getAttribute('aria-expanded')).toBe('true');
		expect(openedPopouts).toHaveLength(0);
	});

	// closing the sheet unmounts the activity list (Sheet.Root), so its cleanup marks it read once; the button needs
	// no markRead of its own.
	it('marks the activity read when the phone sheet closes', () => {
		runInAction(() => ((MobileLayout as {enabled: boolean}).enabled = true));
		feedNotificationCommands.markRead.mockClear();
		render();
		act(() => button().click());
		expect(feedNotificationCommands.markRead).not.toHaveBeenCalled();
		act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(button().getAttribute('aria-expanded')).toBe('false');
		expect(feedNotificationCommands.markRead).toHaveBeenCalledTimes(1);
	});
});

// happy-dom has no layout or media queries, so the stylesheet is read (like FeedLinkPreview.test.tsx).
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

describe('FeedNotificationsButton styles', () => {
	const css = read('./FeedNotificationsButton.module.css');
	const TOUCH = '@media (max-width: 640px), (pointer: coarse) {';

	it('sits at the right end of the feed header with the channel header colours', () => {
		expect(css).toMatch(/\n\.wrapper \{[^}]*margin-inline-start: auto;/);
		expect(css).toMatch(/\n\.wrapper \{[^}]*--channel-header-text-muted: var\(--text-primary-muted\);/);
	});

	it('grows to a 44px touch target and keeps the badge on the icon', () => {
		const touch = css.slice(css.indexOf(TOUCH));
		expect(css.indexOf(TOUCH)).toBeGreaterThan(-1);
		expect(touch).toMatch(/\.wrapper \.button \{[^}]*width: 2\.75rem;[^}]*height: 2\.75rem;/);
		expect(css).toMatch(/\n\.badge \{[^}]*position: absolute;/);
		expect(touch).toMatch(/\.wrapper \.badge \{[^}]*top: 0\.375rem;[^}]*right: 0\.375rem;/);
	});
});
