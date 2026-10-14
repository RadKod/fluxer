// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {shopStageLayout} from '@app/features/shop/utils/ShopStageLayout';
import {
	PROFILE_POPOUT_GEOMETRY as G,
	getProfileAvatarDecorationBounds,
	getProfileAvatarLeft,
} from '@app/features/user/constants/UserProfileSurfaceGeometry';
import type {User} from '@app/features/user/models/User';
import type {
	CosmeticItemResponse,
	UltraLayoutSurface,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeUser {
	id: string;
	avatarDecoration?: unknown;
	avatarUltra?: unknown;
	avatar_decoration_data?: unknown;
	avatar_ultra_data?: unknown;
	nameplate_data?: unknown;
	withUpdates: (updates: Record<string, unknown>) => FakeUser;
}

const users = vi.hoisted(() => ({currentUser: null as unknown}));
const viewport = vi.hoisted(() => ({near: true}));
const geometry = vi.hoisted(() => ({profile: null as UltraLayoutSurface | null, front: false}));
const seen = vi.hoisted(() => ({
	avatar: null as {user: FakeUser; decorationSurface: string; forceAnimate?: boolean; size?: number} | null,
	profile: null as {user: FakeUser; previewProfileEffect: unknown} | null,
	row: null as {user: FakeUser; animateNameplate?: boolean} | null,
	all: [] as Array<{kind: string; user: FakeUser; previewProfileEffect?: unknown}>,
}));

vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({
	default: {
		frontFor: () => (geometry.front ? {closed: 'closed', open: ['closed', 'open'], idle: 'idle'} : null),
		layoutFor: () => ({profile: geometry.profile}),
	},
}));
vi.mock('@app/features/ui/components/Avatar', () => ({
	Avatar: (props: {user: FakeUser; decorationSurface: string; forceAnimate?: boolean; size?: number}) => {
		seen.avatar = props;
		seen.all.push({kind: 'avatar', user: props.user});
		return null;
	},
}));
vi.mock('@app/features/user/state/Users', () => ({default: users}));
// The user wears an effect of their own too.
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({
	default: {equippedId: () => '40', getItem: () => ({id: '40', asset: 'own-effect'})},
}));
vi.mock('@app/features/messaging/hooks/useNearViewport', () => ({
	useNearViewport: () => ({ref: () => {}, isNearViewport: viewport.near}),
}));
vi.mock('@app/features/user/components/profile/ProfilePreview', () => ({
	ProfilePreview: (props: {user: FakeUser; previewProfileEffect: unknown}) => {
		seen.profile = props;
		seen.all.push({kind: 'profile', user: props.user, previewProfileEffect: props.previewProfileEffect});
		return null;
	},
}));
vi.mock('@app/features/shop/components/previews/ShopMemberRowPreview', () => ({
	ShopMemberRowPreview: (props: {user: FakeUser; animateNameplate?: boolean}) => {
		seen.row = props;
		seen.all.push({kind: 'row', user: props.user});
		return null;
	},
}));

const {ShopItemStage} = await import('@app/features/shop/components/ShopItemStage');

function fakeUser(fields: Partial<FakeUser> = {}): FakeUser {
	return {
		id: '1',
		...fields,
		get avatarDecoration() {
			return this.avatar_decoration_data;
		},
		get avatarUltra() {
			return this.avatar_ultra_data;
		},
		withUpdates(updates) {
			return fakeUser({...this, ...updates});
		},
	};
}

function item(id: string, type: CosmeticItemResponse['type']): CosmeticItemResponse {
	return {id, type, name: `Item ${id}`, description: null, asset: `hash${id}`, availability: 'owned'};
}

describe('ShopItemStage', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		// Test account: an owned frame and nameplate and the Yitik Melek wings.
		users.currentUser = fakeUser({
			avatar_decoration_data: {asset: 'own-frame', item_id: '10'},
			avatar_ultra_data: {asset: 'yitik-melek', item_id: '20'},
			nameplate_data: {asset: 'own-plate', item_id: '30'},
		});
		seen.profile = null;
		seen.avatar = null;
		seen.row = null;
		viewport.near = true;
		geometry.profile = null;
		geometry.front = false;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (...items: Array<CosmeticItemResponse>) =>
		act(() => root.render(createElement(ShopItemStage, {items, size: 'grid'})));
	const stageType = () => container.querySelector('[data-size]')?.getAttribute('data-type');

	it.each(['avatar_decoration', 'avatar_ultra'] as const)(
		'plays the inert %s preview by default and follows the card animation state',
		(type) => {
			render(item('1', type));
			expect(seen.avatar?.forceAnimate).toBe(true);
			for (const animateNameplate of [false, true, false]) {
				act(() =>
					root.render(createElement(ShopItemStage, {items: [item('1', type)], size: 'grid', animateNameplate})),
				);
				expect(seen.avatar?.forceAnimate).toBe(animateNameplate);
			}
		},
	);

	it.each([null, {width: 6, height: 6, offset_x: 3, offset_y: 3}, {width: 6, height: 6, offset_x: -3, offset_y: -3}])(
		'fits full-stage wing bounds at 390px and 150 percent app zoom with layout %j',
		(profile) => {
			geometry.front = true;
			geometry.profile = profile;
			act(() => root.render(createElement(ShopItemStage, {items: [item('2', 'avatar_ultra')], size: 'full'})));
			const previewUser = seen.profile!.user as unknown as User;
			const bounds = getProfileAvatarDecorationBounds(previewUser, G.avatarSizePx, G.avatarBorderPx);
			const avatarLeft = getProfileAvatarLeft({
				decorationLeft: bounds.left,
				size: G.avatarSizePx,
				border: G.avatarBorderPx,
				edgePadding: G.avatarLeftPx,
				containerWidth: G.contentWidthPx,
			});
			const style = container.querySelector<HTMLElement>('[data-flx="shop.shop-item-stage.stage"]')!.style;
			const rootFontSize = 24;
			// Real 390px modal content leaves 291px for the Stage at this font size. Happy DOM has no layout engine;
			// resolve emitted lengths here, then apply the CSS container-fit zoom to the renderer's real bounds.
			const stageWidth = 291;
			const screenPx = (variable: string) => {
				const css = style.getPropertyValue(variable);
				return Number.parseFloat(css) * (css.endsWith('rem') ? rootFontSize : 1);
			};
			const naturalWidth = screenPx('--natural-w');
			const zoom = Math.min(Number(style.getPropertyValue('--stage-scale')), stageWidth / naturalWidth);
			const origin = screenPx('--card-x') + (G.borderWidthPx + avatarLeft + G.avatarBorderPx) * (rootFontSize / 16);
			const centeredLeft = (stageWidth - naturalWidth * zoom) / 2;
			expect(centeredLeft + (origin + bounds.left * (rootFontSize / 16)) * zoom).toBeGreaterThanOrEqual(0);
			expect(centeredLeft + (origin + bounds.right * (rootFontSize / 16)) * zoom).toBeLessThanOrEqual(stageWidth);
		},
	);

	it('scales all scene lengths with the avatar at 150 percent app zoom', () => {
		geometry.profile = {width: 6, height: 6, offset_x: -3, offset_y: 3};
		render(item('2', 'avatar_ultra'));
		const layout = shopStageLayout(seen.avatar!.user as unknown as User, 'grid');
		const style = container.querySelector<HTMLElement>('[data-flx="shop.shop-item-stage.stage"]')!.style;
		const rootFontSizeAt150Percent = 24;
		for (const [variable, basePx] of [
			['--natural-w', layout.width],
			['--natural-h', layout.height!],
			['--card-x', layout.cardX],
			['--card-y', layout.cardY],
		] as const) {
			const css = style.getPropertyValue(variable);
			const screenPx = Number.parseFloat(css) * (css.endsWith('rem') ? rootFontSizeAt150Percent : 1);
			expect(screenPx).toBeCloseTo(basePx * 1.5, 3);
		}
	});

	it('defers off-screen grid content and keeps mounted grid previews inert', () => {
		viewport.near = false;
		render(item('1', 'avatar_decoration'));
		expect(seen.profile).toBeNull();
		viewport.near = true;
		render(item('1', 'avatar_decoration'));
		expect(seen.avatar).not.toBeNull();
		expect(container.querySelector('[data-flx="shop.shop-item-stage.natural"]')?.hasAttribute('inert')).toBe(true);
	});

	it("a frame's card wears only that frame: none of the user's own items, not their effect", () => {
		render(item('1', 'avatar_decoration'));

		expect(seen.avatar?.user).toMatchObject({
			avatar_decoration_data: {asset: 'hash1', item_id: '1'},
			avatar_ultra_data: null,
			nameplate_data: null,
		});
		expect(seen.profile).toBeNull();
		expect(seen.avatar?.decorationSurface).toBe('profile');
	});

	it("an ultra's card wears only that ultra", () => {
		render(item('2', 'avatar_ultra'));

		expect(seen.avatar?.user).toMatchObject({
			avatar_decoration_data: null,
			avatar_ultra_data: {asset: 'hash2', item_id: '2'},
			nameplate_data: null,
		});
		expect(seen.profile).toBeNull();
		expect(seen.avatar?.decorationSurface).toBe('profile');
	});

	it("an effect's card wears only that effect", () => {
		render(item('3', 'profile_effect'));

		expect(seen.profile?.user).toMatchObject({
			avatar_decoration_data: null,
			avatar_ultra_data: null,
			nameplate_data: null,
		});
		expect(seen.profile?.previewProfileEffect).toEqual({asset: 'hash3', item_id: '3'});
	});

	it("a nameplate's member row wears only that nameplate", () => {
		render(item('4', 'nameplate'));

		expect(seen.row?.user).toMatchObject({
			avatar_decoration_data: null,
			avatar_ultra_data: null,
			nameplate_data: {asset: 'hash4', item_id: '4'},
		});
	});

	it('a bundle grid uses one avatar instead of mounting a profile and a second member avatar', () => {
		render(item('1', 'avatar_decoration'), item('3', 'profile_effect'), item('4', 'nameplate'));
		expect(seen.avatar?.user).toMatchObject({avatar_decoration_data: {asset: 'hash1', item_id: '1'}});
		expect(seen.profile).toBeNull();
		expect(seen.row).toBeNull();
	});

	it('a full bundle keeps the real profile and member row', () => {
		act(() =>
			root.render(
				createElement(ShopItemStage, {
					items: [item('1', 'avatar_decoration'), item('3', 'profile_effect'), item('4', 'nameplate')],
					size: 'full',
				}),
			),
		);
		expect(seen.profile?.previewProfileEffect).toEqual({asset: 'hash3', item_id: '3'});
		expect(seen.row).not.toBeNull();
		expect(seen.avatar).toBeNull();
	});

	it('a bundle without a nameplate draws no member row', () => {
		render(item('1', 'avatar_decoration'), item('3', 'profile_effect'));

		expect(seen.avatar).not.toBeNull();
		expect(seen.row).toBeNull();
	});

	it('a bundle with wings takes the ultra band, wherever the wings are in the list', () => {
		render(item('1', 'avatar_decoration'), item('2', 'avatar_ultra'));

		expect(stageType()).toBe('avatar_ultra');
		expect(seen.avatar?.user).toMatchObject({
			avatar_decoration_data: {asset: 'hash1', item_id: '1'},
			avatar_ultra_data: {asset: 'hash2', item_id: '2'},
		});
	});

	// a card's nameplate plays only while the card is hovered (the card says so); the item dialog and
	// the checkout, equipped and gift dialogs, which pass nothing, always play it.
	it('plays the nameplate unless the card holds it still', () => {
		act(() => root.render(createElement(ShopItemStage, {items: [item('4', 'nameplate')], size: 'full'})));
		expect(seen.row?.animateNameplate).toBe(true);

		act(() => root.render(createElement(ShopItemStage, {items: [item('4', 'nameplate')], size: 'grid'})));
		expect(seen.row?.animateNameplate).toBe(true);

		act(() =>
			root.render(
				createElement(ShopItemStage, {items: [item('4', 'nameplate')], size: 'grid', animateNameplate: false}),
			),
		);
		expect(seen.row?.animateNameplate).toBe(false);

		act(() =>
			root.render(
				createElement(ShopItemStage, {
					items: [item('1', 'avatar_decoration'), item('4', 'nameplate')],
					size: 'grid',
					animateNameplate: false,
				}),
			),
		);
		expect(seen.row?.animateNameplate).toBe(false);
	});

	it('a bundle of nameplates only draws the member row', () => {
		render(item('4', 'nameplate'), item('6', 'nameplate'));

		expect(stageType()).toBe('nameplate');
		expect(seen.profile).toBeNull();
		expect(seen.row?.user).toMatchObject({nameplate_data: {asset: 'hash4', item_id: '4'}});
	});

	// A bundle on its shop card shows every item at once: the avatar, the nameplate strip and the profile card.
	const composed = (...items: Array<CosmeticItemResponse>) => {
		seen.all = [];
		act(() =>
			root.render(createElement(ShopItemStage, {items, size: 'grid', composed: true, animateNameplate: false})),
		);
	};
	const slots = () =>
		[...(container.querySelector('[data-flx="shop.shop-item-stage.composition"]')?.children ?? [])].map((slot) =>
			slot.firstElementChild?.getAttribute('data-flx'),
		);

	it('a composed bundle stage draws the avatar, the nameplate row and the profile card together', () => {
		composed(item('1', 'avatar_decoration'), item('2', 'nameplate'), item('3', 'profile_effect'));
		const stage = container.querySelector('[data-size]');

		expect(stage?.hasAttribute('data-composed')).toBe(true);
		expect(stage?.getAttribute('style')).toBeNull();
		// Each item in its own slot, worn alone.
		expect(seen.avatar?.user).toMatchObject({avatar_decoration_data: {asset: 'hash1', item_id: '1'}});
		expect(seen.avatar?.user.nameplate_data).toBeNull();
		expect(seen.row?.user).toMatchObject({nameplate_data: {asset: 'hash2', item_id: '2'}});
		expect(seen.profile?.previewProfileEffect).toEqual({asset: 'hash3', item_id: '3'});
		expect(seen.avatar?.forceAnimate).toBe(false);
		expect(seen.row?.animateNameplate).toBe(false);
		// Avatar, nameplate, profile card: left to right, one slot each.
		const composition = container.querySelector('[data-flx="shop.shop-item-stage.composition"]');
		expect(composition?.getAttribute('data-parts')).toBe('3');
		expect([...(composition?.children ?? [])].map((slot) => slot.firstElementChild?.getAttribute('data-flx'))).toEqual([
			'shop.shop-item-stage.composition-avatar',
			'shop.shop-item-stage.composition-plate',
			'shop.shop-item-stage.composition-panel',
		]);
	});

	it('a composed stage gives every item its own slot, also items of the same type', () => {
		composed(item('1', 'nameplate'), item('2', 'nameplate'), item('3', 'nameplate'));
		const composition = container.querySelector('[data-flx="shop.shop-item-stage.composition"]');
		expect(composition?.getAttribute('data-parts')).toBe('3');
		expect(slots()).toEqual([
			'shop.shop-item-stage.composition-plate',
			'shop.shop-item-stage.composition-plate',
			'shop.shop-item-stage.composition-plate',
		]);
		expect(seen.all.map(({user}) => (user.nameplate_data as {item_id: string}).item_id)).toEqual(['1', '2', '3']);

		composed(item('4', 'avatar_decoration'), item('5', 'avatar_decoration'));
		expect(seen.all.map(({kind, user}) => [kind, (user.avatar_decoration_data as {item_id: string}).item_id])).toEqual([
			['avatar', '4'],
			['avatar', '5'],
		]);
	});

	it('orders the slots avatar items first, then nameplates, then profile effects, up to ten items', () => {
		composed(item('1', 'profile_effect'), item('2', 'nameplate'), item('3', 'avatar_decoration'));
		expect(slots()).toEqual([
			'shop.shop-item-stage.composition-avatar',
			'shop.shop-item-stage.composition-plate',
			'shop.shop-item-stage.composition-panel',
		]);
		const ten = Array.from({length: 10}, (_, index) =>
			item(String(index + 10), index % 2 === 0 ? 'avatar_decoration' : 'nameplate'),
		);
		composed(...ten);
		expect(container.querySelector('[data-flx="shop.shop-item-stage.composition"]')?.getAttribute('data-parts')).toBe(
			'10',
		);
		expect(slots()).toHaveLength(10);
	});

	it('a bundle card draws ultra wings at their natural size, as in chat: no scale of their own', () => {
		composed(item('5', 'avatar_ultra'), item('2', 'nameplate'));
		expect(seen.avatar).toMatchObject({size: 40, decorationSurface: 'compact'});
		const ultra = container.querySelector('[data-flx="shop.shop-item-stage.composition-ultra"]');
		expect(ultra).not.toBeNull();
		expect(container.querySelector('[data-flx="shop.shop-item-stage.composition-avatar"]')).toBeNull();
	});

	it('a composed stage draws only the parts its bundle has', () => {
		composed(item('5', 'avatar_ultra'), item('2', 'nameplate'));

		expect(seen.avatar?.user).toMatchObject({avatar_ultra_data: {asset: 'hash5', item_id: '5'}});
		expect(seen.row).not.toBeNull();
		expect(seen.profile).toBeNull();
		const composition = container.querySelector('[data-flx="shop.shop-item-stage.composition"]');
		expect(composition?.getAttribute('data-parts')).toBe('2');
		expect(composition?.hasAttribute('data-ultra')).toBe(true);
	});
});
