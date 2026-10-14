// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (d: {message: string}) => d.message, locale: 'en'}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({
	default: {
		getSnapshotOrNull: () => null,
		isSelfHosted: () => true,
		inviteUrlBase: 'https://micup.test/invite',
		giftUrlBase: 'https://micup.test/gift',
		mediaEndpoint: 'https://media.micup.test/',
		staticCdnEndpoint: 'https://static.micup.test',
	},
}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		static create = () => new this();
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
// libfluxcore and the markdown parser are Rust compiled to WASM and exist only after `wasm:codegen` (Linux, KL7).
vi.mock('@app/features/messaging/utils/markdown/parser/MarkdownParserWasm', () => ({
	preloadMarkdownParserWasm: async () => {},
	parseMarkdownAstWithWasm: () => ({nodes: []}),
}));
vi.mock('@app/features/platform/utils/LibFluxcore', () => ({
	isLibfluxcoreReady: () => false,
	ensureLibfluxcoreReady: async () => {},
}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {layoutFor: () => null, frontFor: () => null},
}));
vi.mock('@app/features/messaging/utils/ImageCacheUtils', () => ({loadImage: () => () => {}}));
// The avatar has its own tests; here it only shows its size and what it draws behind the avatar.
vi.mock('@app/features/ui/components/BaseAvatar', () => ({
	BaseAvatar: ({size, underlay}: {size: number; underlay?: React.ReactNode}) =>
		createElement('span', {'data-slot': 'under', 'data-size': size}, underlay),
}));
// The profile popout opens on click; the preview row is inert, so it never opens.
vi.mock('@app/features/channel/components/PreloadableUserPopout', () => ({
	PreloadableUserPopout: ({children}: {children: React.ReactNode}) => children,
}));

// The member row imports stores that read the page bootstrap at import time.
(window as unknown as {__FLUXER_BOOTSTRAP__: unknown}).__FLUXER_BOOTSTRAP__ = {
	instance: {app_public: {branding: {product_name: 'Micup'}}},
	config: {releaseChannel: 'stable', bootstrapApiEndpoint: 'https://micup.test/api'},
	geoip: {
		countryCode: 'TR',
		regionCode: null,
		latitude: null,
		longitude: null,
		ageRestrictedGeos: [],
		ageBlockedGeos: [],
	},
};

// Idle and LocalPresence import each other; loading Idle first keeps its timer from calling a half-loaded store.
await import('@app/features/ui/state/Idle');
const {ShopMemberRowPreview} = await import('@app/features/shop/components/previews/ShopMemberRowPreview');
const {User} = await import('@app/features/user/models/User');

const user = new User({
	id: '1200000000000000003',
	username: 'ayse',
	discriminator: '0001',
	global_name: 'Ayşe',
	avatar: null,
	avatar_color: null,
	flags: 0,
	avatar_ultra_data: {asset: '9a8b7c6d', item_id: '1300000000000000009'},
	nameplate_data: {asset: '5e6f7a8b', item_id: '1300000000000000004'},
});

describe('ShopMemberRowPreview', () => {
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

	it('draws the real member row for a user outside any community', () => {
		act(() => root.render(createElement(ShopMemberRowPreview, {user})));
		const row = container.querySelector('[data-flx="shop.shop-member-row-preview.row"]');
		expect(row?.hasAttribute('inert')).toBe(true);
		expect(row?.querySelector('[data-flx="channel.member-list-item.name"]')?.textContent).toBe('Ayşe');
		expect(row?.querySelector('[data-flx="cosmetics.nameplate-background.image"]')?.getAttribute('src')).toContain(
			'cosmetic-nameplate-1300000000000000004',
		);
		const avatar = row?.querySelector('[data-slot="under"]');
		expect(avatar?.getAttribute('data-size')).toBe('32');
		expect(avatar?.querySelector('img')?.getAttribute('src')).toContain('cosmetic-avatar_ultra-1300000000000000009');
	});

	// Inert, the row never sees a hover; its nameplate plays on its own, like a decoration on the profile card.
	it('plays an animated nameplate without a hover', () => {
		const plated = user.withUpdates({nameplate_data: {asset: 'a_5e6f7a8b', item_id: '1300000000000000004'}});
		act(() => root.render(createElement(ShopMemberRowPreview, {user: plated})));
		const src = container.querySelector('[data-flx="cosmetics.nameplate-background.image"]')?.getAttribute('src');
		expect(src).toContain('cosmetic-nameplate-1300000000000000004/a_5e6f7a8b.webp');
		expect(src).toContain('animated=true');
	});

	// The premium page's perk tile plays its moving images only while hovered, so it can hold the nameplate still.
	it('keeps the nameplate still when asked not to animate', () => {
		const plated = user.withUpdates({nameplate_data: {asset: 'a_5e6f7a8b', item_id: '1300000000000000004'}});
		act(() => root.render(createElement(ShopMemberRowPreview, {user: plated, animateNameplate: false})));
		const src = container.querySelector('[data-flx="cosmetics.nameplate-background.image"]')?.getAttribute('src');
		expect(src).toContain('cosmetic-nameplate-1300000000000000004/5e6f7a8b.webp');
		expect(src).not.toContain('animated=true');
	});
});
