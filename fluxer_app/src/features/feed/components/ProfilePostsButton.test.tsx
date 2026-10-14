// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({featureFeed: 1, bot: false, pushed: 0}));

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
vi.mock('@app/features/user/state/Users', () => ({
	default: {getUser: (id: string) => ({id, bot: state.bot, system: false})},
}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	modal: (render: unknown) => render,
	push: () => {
		state.pushed += 1;
	},
}));
vi.mock('@app/features/feed/components/FeedUserPostsModal', () => ({FeedUserPostsModal: () => null}));

const {ProfilePostsButton} = await import('@app/features/feed/components/ProfilePostsButton');

describe('ProfilePostsButton', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		state.featureFeed = 1;
		state.bot = false;
		state.pushed = 0;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = () => act(() => root.render(createElement(ProfilePostsButton, {userId: '42'})));

	it('opens the posts of the user', () => {
		render();
		const button = container.querySelector('button');
		expect(button?.getAttribute('aria-label')).toBe('Posts');
		act(() => button?.click());
		expect(state.pushed).toBe(1);
	});

	it('is gone when the feed is off (feature_feed = 0)', () => {
		state.featureFeed = 0;
		render();
		expect(container.innerHTML).toBe('');
	});

	it('is gone for bots, which do not post', () => {
		state.bot = true;
		render();
		expect(container.innerHTML).toBe('');
	});
});
