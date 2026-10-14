// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {elementSupportsRef} from '@app/lib/react';
import {act, cloneElement, createElement, type ReactElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const renders = vi.hoisted(() => ({
	popout: vi.fn(),
	usePopout: vi.fn(),
	header: vi.fn(),
	supportsRef: vi.fn(),
	target: vi.fn(),
	open: vi.fn(),
}));
const readState = await vi.hoisted(async () => {
	const {observable} = await import('mobx');
	return {
		count: observable.box(0),
		unrelatedMessage: observable.box(0),
		activity: observable.box(0),
		feedEnabled: observable.box(true),
	};
});

vi.mock('@app/features/guild/state/GuildReadState', () => ({
	default: {mentionCountAcrossGuilds: () => readState.count.get()},
}));
vi.mock('@app/features/inbox/state/FeedNotifications', () => ({
	default: {
		get unreadCount() {
			return readState.activity.get();
		},
	},
}));
vi.mock('@app/features/feed/utils/FeedUtils', () => ({isFeedEnabled: () => readState.feedEnabled.get()}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: {message: string}) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			_: (descriptor: {message: string}, values?: Record<string, number>) =>
				descriptor.message.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name])),
		},
	}),
}));
vi.mock('@app/features/i18n/utils/CommonMessageDescriptors', () => ({INBOX_DESCRIPTOR: {message: 'Inbox'}}));
vi.mock('@app/features/devtools/state/DeveloperMode', () => ({default: {isDeveloper: false}}));
vi.mock('@app/features/channel/components/channel_header_components/DeveloperToolsContextMenu', () => ({
	DeveloperToolsContextMenu: () => null,
}));
vi.mock('@app/features/ui/commands/ContextMenuCommands', () => ({}));
vi.mock('@app/features/ui/hooks/useContextMenuTrigger', () => ({useContextMenuTrigger: () => ({})}));
vi.mock('@app/features/ui/hooks/usePopout', () => ({
	usePopout: () => {
		renders.usePopout();
		return {isOpen: false, openProps: {}};
	},
}));
vi.mock('@app/features/messaging/components/popouts/InboxPopout', () => ({InboxPopout: () => null}));
vi.mock('@app/features/ui/popover/PopoverPopout', () => ({
	Popout: ({children}: {children: ReactNode}) => {
		renders.popout();
		const child = children as ReactElement<{
			ref?: React.Ref<HTMLButtonElement>;
			onClick?: () => void;
			'aria-expanded'?: boolean;
			'aria-controls'?: string;
		}>;
		const supportsRef = elementSupportsRef(child);
		renders.supportsRef(supportsRef);
		return cloneElement(child, {
			onClick: renders.open,
			'aria-expanded': true,
			'aria-controls': 'test-inbox-popout',
			...(supportsRef ? {ref: renders.target} : {}),
		});
	},
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/keybind_hint/KeybindHint', () => ({TooltipWithKeybind: () => null}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: true}}));
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'en-US'}));
vi.mock('@app/features/ui/motion/AnimeElement', () => ({
	AnimePresence: ({children}: {children: ReactNode}) => children,
	AnimeTweenType: {SPRING: 'spring'},
	createAnimeFlxElement: () => 'div',
}));

const {runInAction} = await import('mobx');
const {observer} = await import('mobx-react-lite');
const {InboxButton} = await import('./UtilityButtons');

let container: HTMLDivElement;
let root: Root;

function setCount(count: number): void {
	act(() => runInAction(() => readState.count.set(count)));
}

function setActivity(count: number): void {
	act(() => runInAction(() => readState.activity.set(count)));
}

const badgeText = () => container.querySelector('[data-flx="ui.mention-badge.badge"]')?.textContent ?? null;
const label = () => container.querySelector('button')?.getAttribute('aria-label');

function render(): void {
	const Header = observer(() => {
		renders.header();
		return createElement(InboxButton, {className: 'test-inbox'});
	});
	act(() => root.render(createElement(Header)));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	runInAction(() => {
		readState.count.set(0);
		readState.unrelatedMessage.set(0);
		readState.activity.set(0);
		readState.feedEnabled.set(true);
	});
	vi.clearAllMocks();
	container = document.createElement('div');
	root = createRoot(container);
});

afterEach(() => act(() => root.unmount()));

describe('InboxButton mention badge', () => {
	it('keeps the button as the popout anchor and forwards its click handler', () => {
		render();
		expect(renders.supportsRef).toHaveBeenCalledWith(true);
		expect(renders.target).toHaveBeenCalledWith(container.querySelector('button'));
		expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
		expect(container.querySelector('button')?.getAttribute('aria-controls')).toBe('test-inbox-popout');
		act(() => container.querySelector('button')?.click());
		expect(renders.open).toHaveBeenCalledTimes(1);
	});

	it('hides zero and shows a new unread mention with an accessible count', () => {
		render();
		expect(container.querySelector('[data-flx="ui.mention-badge.badge"]')).toBeNull();
		expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Inbox');
		setCount(1);
		expect(container.querySelector('[data-flx="ui.mention-badge.badge"]')?.textContent).toBe('1');
		expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Inbox, unread mentions: 1');
		expect(container.querySelector('button')?.classList.contains('test-inbox')).toBe(true);
	});

	it('caps the visible count at 99+ while keeping the full accessible count', () => {
		setCount(120);
		render();
		expect(container.querySelector('[data-flx="ui.mention-badge.badge"]')?.textContent).toBe('99+');
		expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Inbox, unread mentions: 120');
		setCount(1200);
		expect(container.querySelector('[data-flx="ui.mention-badge.badge"]')?.textContent).toBe('99+');
	});

	it('decreases and clears the badge when mentions are read', () => {
		setCount(6);
		render();
		setCount(2);
		expect(container.querySelector('[data-flx="ui.mention-badge.badge"]')?.textContent).toBe('2');
		expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Inbox, unread mentions: 2');
		setCount(0);
		expect(container.querySelector('[data-flx="ui.mention-badge.badge"]')).toBeNull();
		expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Inbox');
	});

	it('updates the count without rendering the header or popout again', () => {
		render();
		setCount(3);
		expect(container.querySelector('[data-flx="ui.mention-badge.badge"]')?.textContent).toBe('3');
		act(() => runInAction(() => readState.unrelatedMessage.set(1)));
		expect(renders.header).toHaveBeenCalledTimes(1);
		expect(renders.popout).toHaveBeenCalledTimes(1);
		expect(renders.usePopout).toHaveBeenCalledTimes(1);
	});
});

// The feed page's inbox button opens the same inbox, so the channel and DM header badge counts its Activity tab too.
describe('InboxButton feed activity badge', () => {
	it('shows unread feed activity, added to unread mentions', () => {
		render();
		setActivity(3);
		expect(badgeText()).toBe('3');
		expect(label()).toBe('Inbox, unread');
		setCount(2);
		expect(badgeText()).toBe('5');
		expect(label()).toBe('Inbox, unread mentions: 2');
		setActivity(0);
		expect(badgeText()).toBe('2');
		setCount(0);
		expect(badgeText()).toBeNull();
		expect(label()).toBe('Inbox');
	});

	it('shows a capped activity count with a plus', () => {
		setActivity(10);
		render();
		expect(badgeText()).toBe('9+');
		setCount(3);
		expect(badgeText()).toBe('12+');
		setCount(95);
		expect(badgeText()).toBe('99+');
	});

	it('updates on new activity without rendering the header or popout again', () => {
		render();
		setActivity(3);
		expect(badgeText()).toBe('3');
		setActivity(10);
		expect(badgeText()).toBe('9+');
		expect(renders.header).toHaveBeenCalledTimes(1);
		expect(renders.popout).toHaveBeenCalledTimes(1);
		expect(renders.usePopout).toHaveBeenCalledTimes(1);
	});

	it('leaves the activity out while the feed is off', () => {
		act(() => runInAction(() => readState.feedEnabled.set(false)));
		setActivity(3);
		render();
		expect(badgeText()).toBeNull();
		expect(label()).toBe('Inbox');
	});
});
