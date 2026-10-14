// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {ProfileCardBanner} from '@app/features/user/components/profile/profile_card/ProfileCardBanner';
import type {User} from '@app/features/user/models/User';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/hooks/useAnimatedImageUrl', () => ({
	useAnimatedImageUrl: ({staticUrl}: {staticUrl: string | null}) => ({imageUrl: staticUrl}),
}));
vi.mock('@app/features/channel/components/embeds/media/GifIndicator', () => ({GifIndicator: () => null}));
vi.mock('@app/features/ui/components/StatusAwareAvatar', () => ({StatusAwareAvatar: () => null}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children?: ReactNode}) => children,
}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {frontFor: () => null, layoutFor: () => null},
}));

describe('ProfileCardBanner decoration layout', () => {
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

	it.each([
		{decoration: false, ultra: false, left: '0.625rem', height: '8.8375rem'},
		{decoration: true, ultra: false, left: '0.925rem', height: '9.1375rem'},
		{decoration: false, ultra: true, left: '0.625rem', height: '8.75rem'},
		{decoration: true, ultra: true, left: '0.625rem', height: '8.75rem'},
	])('keeps the popout layout for decoration=$decoration ultra=$ultra', ({decoration, ultra, left, height}) => {
		const user = {
			avatarDecoration: decoration ? {} : null,
			avatarUltra: ultra ? {item_id: '7'} : null,
		} as User;
		act(() =>
			root.render(
				createElement(ProfileCardBanner, {
					user,
					bannerUrl: null,
					bannerColor: '#123456',
					avatarUrl: null,
					hoverAvatarUrl: null,
				}),
			),
		);
		const header = container.querySelector('header')!;
		const avatar = container.querySelector('button')!;
		const cutout = container.querySelector('circle')!;
		expect(header.style.height).toBe(height);
		expect(avatar.style.left).toBe(left);
		expect(avatar.style.top).toBe('3.4375rem');
		expect(Number(cutout.getAttribute('cx'))).toBeCloseTo(decoration && !ultra ? 58 : 53.2);
		expect(Number(cutout.getAttribute('cy'))).toBeCloseTo(98.2);
		expect(Number(cutout.getAttribute('r'))).toBeCloseTo(43.2);
	});
});
