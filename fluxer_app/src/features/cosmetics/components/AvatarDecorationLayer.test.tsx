// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {mediaEndpoint: 'https://media.micup.test/'}}));
// The animation policy reads these stores; the real ones start preference sync and the locale loader.
const accessibility = vi.hoisted(() => ({useReducedMotion: false}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: accessibility}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));

const {AvatarDecorationLayer} = await import('@app/features/cosmetics/components/AvatarDecorationLayer');
const {User} = await import('@app/features/user/models/User');

const ANIMATED: CosmeticAssetDataResponse = {asset: 'a_1f2e3d4c', item_id: '1300000000000000001'};
const BASE = 'https://media.micup.test/branding/cosmetic-avatar_decoration-1300000000000000001';

function userWith(decoration: CosmeticAssetDataResponse | null) {
	return new User({
		id: '1200000000000000001',
		username: 'deco',
		discriminator: '0',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
		avatar_decoration_data: decoration,
	});
}

describe('AvatarDecorationLayer', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		accessibility.useReducedMotion = false;
		act(() => root.unmount());
		container.remove();
	});

	const render = (decoration: CosmeticAssetDataResponse | null, animate: boolean, size = 32) =>
		act(() => root.render(createElement(AvatarDecorationLayer, {decoration, size, animate})));

	it('draws nothing when the user wears no decoration', () => {
		render(userWith(null).avatarDecoration, true);
		expect(container.innerHTML).toBe('');
	});

	it('draws the worn decoration from the media proxy branding path', () => {
		render(userWith(ANIMATED).avatarDecoration, true);
		const image = container.querySelector('img');
		expect(image?.getAttribute('src')).toBe(`${BASE}/a_1f2e3d4c.webp?size=128&animated=true`);
		expect(image?.getAttribute('data-flx')).toBe('cosmetics.avatar-decoration-layer.image');
		expect(image?.getAttribute('aria-hidden')).toBe('true');
	});

	it('asks for the static first frame when it may not animate', () => {
		render(userWith(ANIMATED).avatarDecoration, false);
		expect(container.querySelector('img')?.getAttribute('src')).toBe(`${BASE}/1f2e3d4c.webp?size=128`);
	});

	it('keeps the decoration still under reduced motion, on hover and while speaking too', () => {
		accessibility.useReducedMotion = true;
		render(ANIMATED, true);
		expect(container.querySelector('img')?.getAttribute('src')).toBe(`${BASE}/1f2e3d4c.webp?size=128`);
	});

	it('sizes the request for the larger avatar it frames', () => {
		render(ANIMATED, false, 120);
		expect(container.querySelector('img')?.getAttribute('src')).toBe(`${BASE}/1f2e3d4c.webp?size=160`);
	});

	it('leaves avatars smaller than a list row undecorated', () => {
		render(ANIMATED, true, 24);
		expect(container.innerHTML).toBe('');
	});

	it('hides the layer when the image fails to load', () => {
		render(ANIMATED, false);
		act(() => {
			container.querySelector('img')?.dispatchEvent(new Event('error'));
		});
		expect(container.querySelector('img')).toBeNull();
	});
});
