// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import type {ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {setupI18n} from '@lingui/core';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeUser {
	id: string;
	username: string;
	flags: number;
	isPremium: () => boolean;
	avatar_decoration_data?: unknown;
	avatar_ultra_data?: unknown;
	nameplate_data?: unknown;
	withUpdates: (updates: Record<string, unknown>) => FakeUser;
}

const i18n = setupI18n({locale: 'en', messages: {en: {}}});
const catalog = vi.hoisted(() => ({
	itemEntries: [] as Array<ShopItemEntry>,
	settings: {premium_discount_percent: 0} as {premium_discount_percent: number},
	premiumDiscount: false,
}));
const users = vi.hoisted(() => ({currentUser: null as unknown}));
const motion = vi.hoisted(() => ({hovering: false, saveData: false, reduced: false}));
const cosmetics = vi.hoisted(() => ({wornEffect: null as {id: string; asset: string} | null}));
// What the Fluxer previews were handed, by preview.
const seen = vi.hoisted(() => ({
	profile: null as {user: FakeUser; previewProfileEffect: unknown} | null,
	avatar: null as {user: FakeUser; size: number; forceAnimate?: boolean} | null,
	row: null as {user: FakeUser; animateNameplate?: boolean} | null,
}));
const routerUtils = vi.hoisted(() => ({transitionTo: vi.fn()}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n}),
	Trans: ({children}: {children: ReactNode}) => children,
}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/user/state/Users', () => ({default: users}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({
	default: {equippedId: () => cosmetics.wornEffect?.id ?? null, getItem: () => cosmetics.wornEffect},
}));
vi.mock('@app/features/app/utils/UserLimits', () => ({
	Limits: {
		getStockValue: (_key: string, value: number) => value,
		getRestrictedValue: (_key: string, value: number) => value,
	},
}));
vi.mock('@app/features/cosmetics/utils/CosmeticAssetUtils', () => ({
	getCosmeticAssetURL: (type: string, data: {item_id: string}, size: number, animated: boolean) =>
		`https://media.test/${type}/${data.item_id}?size=${size}&animated=${animated}`,
}));
vi.mock('@app/features/premium/utils/PremiumBadgeAsset', () => ({premiumBadgeUrl: () => 'https://cdn.test/badge.svg'}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => routerUtils);
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {isSelfHosted: () => true}}));
vi.mock('@app/features/app/hooks/useHover', () => ({useHover: () => [() => {}, motion.hovering]}));
vi.mock('@app/features/app/hooks/useSaveData', () => ({useSaveData: () => motion.saveData}));
vi.mock('@app/features/accessibility/state/Accessibility', () => ({
	default: {
		get useReducedMotion() {
			return motion.reduced;
		},
		isAnimationKeptUnderReducedMotion: () => false,
	},
}));
// useShouldAnimate reads the animation settings only for emoji, GIFs and stickers.
vi.mock('@app/features/user/state/UserSettings', () => ({default: {}}));
vi.mock('@app/features/user/components/profile/ProfilePreview', () => ({
	ProfilePreview: (props: {user: FakeUser; previewProfileEffect: unknown}) => {
		seen.profile = props;
		return <div data-testid="profile" data-flx="premium.premium-perk-tiles-test.profile" />;
	},
}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: (props: {user: FakeUser; size: number; forceAnimate?: boolean}) => {
		seen.avatar = props;
		return <div data-testid="avatar" data-flx="premium.premium-perk-tiles-test.avatar" />;
	},
}));
vi.mock('@app/features/shop/components/previews/ShopMemberRowPreview', () => ({
	ShopMemberRowPreview: (props: {user: FakeUser; animateNameplate?: boolean}) => {
		seen.row = props;
		return <div data-testid="row" data-flx="premium.premium-perk-tiles-test.row" />;
	},
}));

const {PremiumPerkTiles} = await import('@app/features/premium/components/PremiumPerkTiles');
const {remFromPx} = await import('@app/features/theme/layout/RemFromPx');
const {PROFILE_POPOUT_OUTER_WIDTH_PX} = await import('@app/features/user/constants/UserProfileSurfaceGeometry');

function entry(
	id: string,
	type: CosmeticItemResponse['type'],
	availability: CosmeticItemResponse['availability'],
): ShopItemEntry {
	const item: CosmeticItemResponse = {
		id,
		type,
		name: `Item ${id}`,
		description: null,
		asset: `hash${id}`,
		availability,
	};
	return {kind: 'item', sku: `cosmetic:${id}`, item, price: null};
}

function fakeUser(fields: Partial<FakeUser> = {}): FakeUser {
	return {
		id: '1',
		username: 'epha',
		flags: 0,
		isPremium: () => false,
		...fields,
		withUpdates(updates) {
			return fakeUser({...this, ...updates});
		},
	};
}

// Test account: an owned decoration and nameplate and the Yitik Melek wings; an owned effect (cosmetics).
const dressedUser = () =>
	fakeUser({
		avatar_decoration_data: {asset: 'own-decoration', item_id: '10'},
		avatar_ultra_data: {asset: 'yitik-melek', item_id: '20'},
		nameplate_data: {asset: 'own-nameplate', item_id: '30'},
	});

// The Gece Tacı set is one decoration, one effect and one nameplate; an owned decoration sits in front of it.
const nightCrownSet = () => [
	entry('10', 'avatar_decoration', 'owned'),
	entry('1', 'avatar_decoration', 'premium'),
	entry('2', 'profile_effect', 'premium'),
	entry('3', 'nameplate', 'premium'),
	entry('4', 'avatar_decoration', 'premium'),
];

describe('PremiumPerkTiles', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let renders = 0;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		catalog.itemEntries = nightCrownSet();
		catalog.settings = {premium_discount_percent: 30};
		catalog.premiumDiscount = false;
		users.currentUser = fakeUser();
		Object.assign(motion, {hovering: false, saveData: false, reduced: false});
		cosmetics.wornEffect = null;
		seen.profile = null;
		seen.avatar = null;
		seen.row = null;
		routerUtils.transitionTo.mockClear();
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	// The stores here are plain objects, so each render mounts afresh instead of waiting for a MobX reaction.
	const render = () => act(() => root.render(createElement(PremiumPerkTiles, {key: ++renders})));
	const titles = () =>
		[...container.querySelectorAll('[data-flx="premium.premium-perk-tiles.tile-title"]')].map((el) => el.textContent);
	const effectSrc = () =>
		container.querySelector<HTMLImageElement>('[data-flx="premium.premium-perk-tiles.effect"]')?.getAttribute('src');
	const tiles = () => [...container.querySelectorAll('[data-flx="premium.premium-perk-tiles.tile"]')];
	const activeTitles = () =>
		tiles()
			.filter((tile) => tile.querySelector('[data-flx="premium.premium-perk-tiles.active"]'))
			.map((tile) => tile.querySelector('[data-flx="premium.premium-perk-tiles.tile-title"]')?.textContent);

	it('names Micup Plus in every foot and calls nothing active for an account without Plus', () => {
		render();

		expect(tiles()).toHaveLength(5);
		for (const tile of tiles()) {
			expect(tile.querySelector('[data-flx="premium.premium-perk-tiles.tier"]')?.textContent).toBe('Micup Plus');
			expect(tile.hasAttribute('data-active')).toBe(false);
		}
		expect(activeTitles()).toEqual([]);
	});

	// Discord's "Active" only on what is really on: a trial wears the decorations but pays the list price, and a
	// hidden badge is not shown to anyone.
	it('marks Active only what the account has on now', () => {
		users.currentUser = fakeUser({isPremium: () => true, flags: PublicUserFlags.PREMIUM_BADGE});
		catalog.premiumDiscount = true;
		render();
		expect(activeTitles()).toEqual(titles());
		expect(tiles().every((tile) => tile.hasAttribute('data-active'))).toBe(true);
		expect(container.querySelector('[data-flx="premium.premium-perk-tiles.active"]')?.textContent).toBe('Active');

		users.currentUser = fakeUser({isPremium: () => true, flags: 0});
		catalog.premiumDiscount = false;
		render();
		expect(activeTitles()).toEqual(['Avatar decoration', 'Profile effect', 'Nameplate']);
		expect(tiles().filter((tile) => tile.hasAttribute('data-active'))).toHaveLength(3);
	});

	it('shows the profile card and the five tiles in order', () => {
		render();

		expect(container.querySelector('h2')?.textContent).toBe('Let everyone notice you');
		expect(container.querySelector('[data-testid="profile"]')).not.toBeNull();
		expect(titles()).toEqual([
			'Avatar decoration',
			'Profile effect',
			'Nameplate',
			'Micup Plus badge',
			'Special discounts in the shop',
		]);
	});

	it('shows a decoration type tile only when the catalog has a premium item of that type', () => {
		catalog.itemEntries = [entry('10', 'avatar_decoration', 'owned'), entry('2', 'profile_effect', 'premium')];
		render();

		expect(titles()).toEqual(['Profile effect', 'Micup Plus badge', 'Special discounts in the shop']);
	});

	it('shows the shop discount tile only above 0', () => {
		catalog.settings = {premium_discount_percent: 0};
		render();

		expect(titles()).not.toContain('Special discounts in the shop');
		expect(container.textContent).not.toContain('Special discount');
	});

	it('dresses the user in every premium item, the first of each type', () => {
		render();

		expect(seen.profile?.user).toMatchObject({
			id: '1',
			avatar_decoration_data: {asset: 'hash1', item_id: '1'},
			nameplate_data: {asset: 'hash3', item_id: '3'},
		});
		expect(seen.profile?.previewProfileEffect).toEqual({asset: 'hash2', item_id: '2'});
		expect(seen.avatar?.user.avatar_decoration_data).toEqual({asset: 'hash1', item_id: '1'});
		expect(seen.row?.user.nameplate_data).toEqual({asset: 'hash3', item_id: '3'});
		expect(
			[...container.querySelectorAll('[data-flx="premium.premium-perk-tiles.legend-item"]')].map(
				(li) => li.textContent,
			),
		).toEqual(['Avatar decoration: Item 1', 'Profile effect: Item 2', 'Nameplate: Item 3']);
	});

	it("wears none of the user's own items, the ultra wings least of all", () => {
		users.currentUser = dressedUser();
		cosmetics.wornEffect = {id: '40', asset: 'own-effect'};
		// Ultra decorations are sold in the shop, never included, even if one were marked premium.
		catalog.itemEntries = [...nightCrownSet(), entry('5', 'avatar_ultra', 'premium')];
		render();

		expect(seen.profile?.user).toMatchObject({
			avatar_decoration_data: {asset: 'hash1', item_id: '1'},
			avatar_ultra_data: null,
			nameplate_data: {asset: 'hash3', item_id: '3'},
		});
		expect(seen.profile?.previewProfileEffect).toEqual({asset: 'hash2', item_id: '2'});
		expect(seen.avatar?.user.avatar_ultra_data).toBeNull();
		expect(seen.row?.user.avatar_ultra_data).toBeNull();
	});

	it('wears nothing and shows only the fixed tiles while the catalog has no premium item', () => {
		users.currentUser = dressedUser();
		cosmetics.wornEffect = {id: '40', asset: 'own-effect'};
		catalog.itemEntries = [entry('10', 'avatar_decoration', 'owned'), entry('20', 'avatar_ultra', 'owned')];
		render();

		expect(seen.profile?.user).toMatchObject({
			avatar_decoration_data: null,
			avatar_ultra_data: null,
			nameplate_data: null,
		});
		expect(seen.profile?.previewProfileEffect).toBeNull();
		expect(titles()).toEqual(['Micup Plus badge', 'Special discounts in the shop']);
		expect(container.querySelector('[data-flx="premium.premium-perk-tiles.legend"]')).toBeNull();
		expect(seen.avatar).toBeNull();
		expect(seen.row).toBeNull();
	});

	it('plays the moving images only on hover, never with Data Saver or reduced motion', () => {
		render();
		expect(effectSrc()).toContain('animated=false');
		expect(seen.avatar?.forceAnimate).toBe(false);
		expect(seen.row?.animateNameplate).toBe(false);

		motion.hovering = true;
		render();
		expect(effectSrc()).toContain('animated=true');
		expect(seen.avatar?.forceAnimate).toBe(true);
		expect(seen.row?.animateNameplate).toBe(true);

		motion.saveData = true;
		render();
		expect(effectSrc()).toContain('animated=false');

		motion.saveData = false;
		motion.reduced = true;
		render();
		expect(effectSrc()).toContain('animated=false');
	});

	it('shows the premium badge at 48 px without a custom tag perk', () => {
		render();

		const badge = container.querySelector<HTMLImageElement>('[data-flx="premium.premium-perk-tiles.badge"]');
		expect(badge?.getAttribute('src')).toBe('https://cdn.test/badge.svg');
		expect(badge?.getAttribute('width')).toBe('48');
		expect(container.querySelector('[data-flx="premium.premium-perk-tiles.tag"]')).toBeNull();
	});

	it('links to the shop for ultra decorations', () => {
		render();

		const link = container.querySelector<HTMLButtonElement>('[data-flx="premium.premium-perk-tiles.shop-link.click"]')!;
		expect(link.textContent).toBe('See ultra decorations and more in the shop');
		act(() => link.click());
		expect(routerUtils.transitionTo).toHaveBeenCalledWith('/shop');
	});

	// The banner's avatar cutout is drawn for the popout's 300 px content box (ProfileCardBanner's viewBox) and grows
	// with the card while the avatar does not: at any other width it slides off the avatar as a dark half moon.
	it('draws the profile card at the popout width, where the banner cutout sits on the avatar', () => {
		const css = readFileSync('src/features/premium/components/PremiumPerkTiles.module.css', 'utf8');
		const showcase = css.split('\n.showcase {')[1]?.split('}')[0] ?? '';
		const width = remFromPx(PROFILE_POPOUT_OUTER_WIDTH_PX);

		expect(css.match(/--profile-card-width: [^;]+/g)).toEqual([`--profile-card-width: ${width}`]);
		expect(showcase).toContain(`--profile-card-width: ${width};`);
		expect(showcase).toContain('grid-template-columns: var(--profile-card-width) minmax(0, 1fr);');
		// A section narrower than the card zooms the whole card, cutout and avatar together.
		expect(css).toMatch(new RegExp(`@container \\(max-width: ${width}\\) \\{\\s*\\.profile \\{\\s*zoom: 0\\.9;`));
	});

	it('draws nothing without a signed in user', () => {
		users.currentUser = null;
		render();

		expect(container.innerHTML).toBe('');
	});
});
