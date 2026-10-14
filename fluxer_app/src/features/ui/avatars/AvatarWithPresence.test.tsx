// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticAssetDataResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {mediaEndpoint: 'https://media.micup.test/', staticCdnEndpoint: 'https://static.micup.test'},
}));
const accessibility = vi.hoisted(() => ({useReducedMotion: false}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({default: accessibility}));
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {getMember: () => undefined}}));
vi.mock('@app/features/messaging/utils/ImageCacheUtils', () => ({loadImage: () => () => {}}));
// The avatar drawing has its own tests; this checks what the voice avatar hands it as the decoration.
vi.mock('@app/features/ui/components/BaseAvatar', () => ({
	BaseAvatar: ({decoration}: {decoration?: React.ReactNode}) => decoration ?? null,
}));

const {AvatarWithPresence} = await import('@app/features/ui/avatars/AvatarWithPresence');
const {User} = await import('@app/features/user/models/User');

const FRAME: CosmeticAssetDataResponse = {asset: 'a_5e6f7a8b', item_id: '1300000000000000002'};
const BASE = 'https://media.micup.test/branding/cosmetic-avatar_decoration-1300000000000000002';

const speaker = new User({
	id: '1200000000000000002',
	username: 'ses',
	discriminator: '0',
	global_name: null,
	avatar: null,
	avatar_color: null,
	flags: 0,
	avatar_decoration_data: FRAME,
});

describe('AvatarWithPresence decoration', () => {
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

	const render = (size: number, speaking: boolean) =>
		act(() => root.render(createElement(AvatarWithPresence, {user: speaker, size, speaking})));
	const src = () => container.querySelector('img')?.getAttribute('src');

	it('frames a voice avatar with the still decoration while the user is quiet', () => {
		render(40, false);
		expect(src()).toBe(`${BASE}/5e6f7a8b.webp?size=128`);
	});

	it('plays the decoration while the user speaks, like the avatar itself', () => {
		render(40, true);
		expect(src()).toBe(`${BASE}/a_5e6f7a8b.webp?size=128&animated=true`);
	});

	it('keeps the decoration still while the user speaks under reduced motion', () => {
		accessibility.useReducedMotion = true;
		render(40, true);
		expect(src()).toBe(`${BASE}/5e6f7a8b.webp?size=128`);
	});

	it('leaves small voice avatars unframed', () => {
		render(24, true);
		expect(container.querySelector('img')).toBeNull();
	});
});
