// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: false}}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: unknown}) => children}));
vi.mock('@app/features/messaging/utils/ImageCacheUtils', () => ({
	hasFailedImage: () => false,
	hasImage: () => false,
	loadImage: () => () => {},
	rememberImage: () => {},
}));

const {BaseAvatar} = await import('@app/features/ui/components/BaseAvatar');

describe('BaseAvatar decoration slots', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const slots = () =>
		[...(container.firstElementChild?.children ?? [])].map(
			(element) => element.getAttribute('data-slot') ?? element.tagName.toLowerCase(),
		);

	it('draws the underlay before the avatar image and the decoration after it', () => {
		act(() =>
			root.render(
				createElement(BaseAvatar, {
					size: 40,
					avatarUrl: 'https://cdn.micup.test/avatar.png',
					underlay: createElement('i', {'data-slot': 'under'}),
					decoration: createElement('i', {'data-slot': 'over'}),
				}),
			),
		);
		expect(slots().slice(0, 3)).toEqual(['under', 'svg', 'over']);
	});

	it('keeps the decoration right after the avatar image when there is no underlay', () => {
		act(() =>
			root.render(
				createElement(BaseAvatar, {
					size: 40,
					avatarUrl: 'https://cdn.micup.test/avatar.png',
					decoration: createElement('i', {'data-slot': 'over'}),
				}),
			),
		);
		expect(slots().slice(0, 2)).toEqual(['svg', 'over']);
	});
});
