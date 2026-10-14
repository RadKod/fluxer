// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {runInAction} from 'mobx';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// Observable like the real RuntimeConfig, so the observer button re-renders when branding changes.
const runtime = await vi.hoisted(async () => {
	const {observable} = await import('mobx');
	return observable({iconUrl: null as string | null});
});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: {message: string}) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
const location = vi.hoisted(() => ({pathname: '/feed'}));
vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({marketingUrl: (path: string) => path}));
vi.mock('@app/features/platform/components/router/RouterReact', () => ({useLocation: () => location}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn()}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: true}}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));

const {FeedButton} = await import('@app/features/app/components/layout/sidebar_nav/FeedButton');

const NEWSPAPER = '[data-flx="app.sidebar-nav.feed-button.icon-text"]';
let container: HTMLDivElement;
let root: Root;

function render(): void {
	container = document.createElement('div');
	root = createRoot(container);
	act(() => root.render(createElement(FeedButton)));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	runtime.iconUrl = null;
	location.pathname = '/feed';
});

afterEach(() => {
	act(() => root.unmount());
});

describe('FeedButton', () => {
	it('draws the instance icon as the feed tile when branding sets one', () => {
		runtime.iconUrl = 'https://media.example/branding/icon.png';
		render();
		const img = container.querySelector('img');
		expect(img?.getAttribute('src')).toBe('https://media.example/branding/icon.png');
		expect(img?.getAttribute('alt')).toBe('Feed');
		expect(container.querySelector(NEWSPAPER)).toBeNull();
		// Like the home tile, the selected feed also shows the rail's left bar.
		expect(container.querySelector('[data-flx="app.sidebar-nav.feed-button.guild-indicator"]')).not.toBeNull();
	});

	it('falls back to the newspaper tile when the instance icon does not load', () => {
		runtime.iconUrl = 'https://media.example/branding/icon.png';
		render();
		act(() => {
			container.querySelector('img')?.dispatchEvent(new Event('error'));
		});
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector(NEWSPAPER)).not.toBeNull();
	});

	it('tries a changed instance icon again after an earlier one failed to load', () => {
		runtime.iconUrl = 'https://media.example/branding/icon.png';
		render();
		act(() => {
			container.querySelector('img')?.dispatchEvent(new Event('error'));
		});
		act(() => {
			runInAction(() => {
				runtime.iconUrl = 'https://media.example/branding/icon-2.png';
			});
		});
		expect(container.querySelector('img')?.getAttribute('src')).toBe('https://media.example/branding/icon-2.png');
		expect(container.querySelector(NEWSPAPER)).toBeNull();
	});

	// Micup: premium, the shop and the bots opened from the feed open inside it (/feed/premium…), so the feed stays
	// the selected tile there, as on a post page.
	it.each([
		['/feed', 'page'],
		['/feed/posts/7', 'page'],
		['/feed/premium', 'page'],
		['/feed/shop', 'page'],
		['/feed/bots', 'page'],
		['/premium', null],
		['/channels/@me', null],
	])('on %s marks the feed tile current: %s', (pathname, current) => {
		location.pathname = pathname;
		render();
		expect(container.querySelector('button')!.getAttribute('aria-current')).toBe(current);
	});

	it('keeps the newspaper icon without a configured instance icon', () => {
		render();
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector(NEWSPAPER)).not.toBeNull();
	});
});
