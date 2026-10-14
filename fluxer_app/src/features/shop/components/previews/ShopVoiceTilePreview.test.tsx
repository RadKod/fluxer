// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const accessibility = vi.hoisted(() => ({useReducedMotion: false}));
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {mediaEndpoint: 'https://media.micup.test/', staticCdnEndpoint: 'https://static.micup.test'},
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: accessibility}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => undefined}}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {layoutFor: () => null, frontFor: () => null},
}));
vi.mock('@app/features/messaging/utils/ImageCacheUtils', () => ({loadImage: () => () => {}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {username: string}) => user.username,
	formatTagForStreamerMode: (tag: string) => tag,
	formatNameForStreamerMode: (name: string) => name,
}));
// The avatar has its own tests; here it only shows its size and what it draws behind the avatar.
vi.mock('@app/features/ui/components/BaseAvatar', () => ({
	BaseAvatar: ({size, underlay}: {size: number; underlay?: React.ReactNode}) =>
		createElement('span', {'data-slot': 'under', 'data-size': size}, underlay),
}));

const {ShopVoiceTilePreview} = await import('@app/features/shop/components/previews/ShopVoiceTilePreview');
const {User} = await import('@app/features/user/models/User');

const BASE = 'https://media.micup.test/branding/cosmetic-avatar_ultra-1300000000000000009';
const user = new User({
	id: '1200000000000000003',
	username: 'ayse',
	discriminator: '0001',
	global_name: 'Ayşe',
	avatar: null,
	avatar_color: null,
	flags: 0,
	avatar_ultra_data: {asset: 'a_9a8b7c6d', item_id: '1300000000000000009'},
});

describe('ShopVoiceTilePreview', () => {
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

	const render = () => act(() => root.render(createElement(ShopVoiceTilePreview, {user})));
	const ultraSource = () => container.querySelector('[data-slot="under"] img')?.getAttribute('src') ?? null;

	it('draws the voice tile avatar with the voice surface and forced animation, still under reduced motion', () => {
		render();
		expect(container.querySelector('[data-slot="under"]')?.getAttribute('data-size')).toBe('192');
		expect(ultraSource()).toBe(`${BASE}/a_9a8b7c6d.webp?size=480&animated=true`);
		expect(container.querySelector('[data-flx="shop.shop-voice-tile-preview.name"]')?.textContent).toBe('Ayşe');
		act(() => root.unmount());
		root = createRoot(container);
		accessibility.useReducedMotion = true;
		render();
		expect(ultraSource()).toBe(`${BASE}/9a8b7c6d.webp?size=480`);
	});
});
