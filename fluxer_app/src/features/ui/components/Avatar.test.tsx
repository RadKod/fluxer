// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UltraFront} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {mediaEndpoint: 'https://media.micup.test/', staticCdnEndpoint: 'https://static.micup.test'},
}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: {useReducedMotion: false}}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => undefined}}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUserId: null}}));
vi.mock('@app/features/messaging/utils/ImageCacheUtils', () => ({loadImage: () => () => {}}));
vi.mock('@app/features/user/utils/NicknameUtils', () => ({
	getNickname: (user: {username: string}) => user.username,
	formatTagForStreamerMode: (tag: string) => tag,
	formatNameForStreamerMode: (name: string) => name,
}));
const fronts = vi.hoisted(() => new Map<string, UltraFront>());
// Read and without a front unless a case sets one: the existing cases draw behind as before.
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {layoutFor: () => null, frontFor: (itemId: string) => fronts.get(itemId) ?? null},
}));
vi.mock('@app/features/cosmetics/components/AvatarUltraFront', () => ({
	AvatarUltraFront: ({itemId}: {itemId: string}) => createElement('i', {'data-front': itemId}),
}));
vi.mock('@app/features/ui/components/BaseAvatar', () => ({
	BaseAvatar: ({underlay, decoration}: {underlay?: React.ReactNode; decoration?: React.ReactNode}) =>
		createElement(
			'div',
			null,
			createElement('span', {'data-slot': 'under'}, underlay),
			createElement('span', {'data-slot': 'over'}, decoration),
		),
}));

const {Avatar} = await import('@app/features/ui/components/Avatar');
const {User} = await import('@app/features/user/models/User');

const ULTRA = {asset: '9a8b7c6d', item_id: '1300000000000000009'};
const FRAME = {asset: '5e6f7a8b', item_id: '1300000000000000002'};
const user = new User({
	id: '1200000000000000003',
	username: 'kanat',
	discriminator: '0',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
	avatar_decoration_data: FRAME,
	avatar_ultra_data: ULTRA,
});

describe('Avatar decorations', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		fronts.clear();
		act(() => root.unmount());
		container.remove();
	});

	const render = (props: Record<string, unknown>) =>
		act(() => root.render(createElement(Avatar, {user, size: 40, ...props})));
	const slot = (name: string) => container.querySelector(`[data-slot="${name}"] img`)?.getAttribute('src') ?? null;

	it('keeps an avatar without a surface wingless but framed', () => {
		render({size: 80});
		expect(slot('under')).toBeNull();
		expect(slot('over')).toContain('cosmetic-avatar_decoration-1300000000000000002');
	});

	it('draws the ultra decoration behind a chat or member list avatar and the frame over it', () => {
		render({decorationSurface: 'compact'});
		expect(slot('under')).toContain('cosmetic-avatar_ultra-1300000000000000009');
		expect(slot('over')).toContain('cosmetic-avatar_decoration-1300000000000000002');
	});

	it('sizes the ultra decoration for a profile surface', () => {
		render({size: 80, decorationSurface: 'profile'});
		expect(slot('under')).toContain('?size=300');
	});

	it('sizes the ultra decoration for a voice tile', () => {
		render({size: 48, decorationSurface: 'voice'});
		expect(slot('under')).toContain('?size=160');
	});

	it('draws an in-front item over the avatar after the frame and nothing under it', () => {
		fronts.set(ULTRA.item_id, {closed: 'c0', open: ['c0', 'f1'], idle: 'a_idle'});
		render({decorationSurface: 'compact'});
		const over = container.querySelector('[data-slot="over"]');
		expect(Array.from(over?.children ?? []).map((node) => node.tagName)).toEqual(['IMG', 'I']);
		expect(over?.querySelector('img')?.getAttribute('src')).toContain('cosmetic-avatar_decoration-1300000000000000002');
		expect(over?.querySelector('[data-front]')?.getAttribute('data-front')).toBe(ULTRA.item_id);
		expect(container.querySelector('[data-slot="under"]')?.innerHTML).toBe('');
	});
});
