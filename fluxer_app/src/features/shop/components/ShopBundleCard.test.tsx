// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopPriceResponse, ShopSettingsResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {observable, runInAction} from 'mobx';
import type React from 'react';
import {act, createElement, type ReactElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message
		.replace(/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g, (_, key: string, one: string, other: string) =>
			(values[key] === 1 ? one : other).replace('#', String(values[key])),
		)
		.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const SETTINGS: ShopSettingsResponse = {
	premium_sales_open: false,
	item_sales_open: true,
	premium_discount_percent: 30,
};
const state = vi.hoisted(() => ({
	settings: null as ShopSettingsResponse | null,
	premiumDiscount: false,
	owned: new Set<string>(),
	claimed: true,
	verified: true as boolean | undefined,
	hovering: false,
	itemEntries: [] as Array<ShopItemEntry>,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {locale: 'en-US', _: interpolate}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/user/utils/LocaleUtils', () => ({getCurrentLocale: () => 'en-US'}));
vi.mock('@app/features/user/utils/DateFormatting', () => ({getFormattedDateTime: (value: string) => value}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({
	default: {
		get settings() {
			return state.settings;
		},
		get premiumDiscount() {
			return state.premiumDiscount;
		},
		get itemEntries() {
			return state.itemEntries;
		},
		// The catalog's clock is observable: it moves when a shown campaign ends.
		now: () => clock.get(),
	},
}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({
	default: {
		getItem: (id: string | null) => (id && state.owned.has(id) ? {id, owned: true} : null),
		equippedId: () => null,
	},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {
				id: 'me',
				isPremium: () => false,
				isClaimed: () => state.claimed,
				verified: state.verified,
				withUpdates: (updates: object) => ({id: 'me', preview: updates}),
			};
		},
	},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({
	modal: (render: () => ReactElement) => render,
	push: vi.fn(),
	pushWithKey: vi.fn(),
}));
vi.mock('@app/app/Routes', () => ({Routes: {SHOP: '/shop'}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({transitionTo: vi.fn()}));
vi.mock('@app/features/app/hooks/useHover', () => ({useHover: () => [() => {}, state.hovering]}));
// Geometry and viewport behavior belong to ShopItemStage tests; cards pass the preview contract.
const stages: Array<{items: ReadonlyArray<CosmeticItemResponse>; size: string; animateNameplate?: boolean}> = [];
vi.mock('@app/features/shop/components/ShopItemStage', () => ({
	ShopItemStage: (props: (typeof stages)[number]) => {
		stages.push(props);
		return createElement('div', {'data-stage': true, 'data-size': props.size});
	},
}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({
	default: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/shop/components/PurchaseDisabledWrapper', () => ({
	PurchaseDisabledWrapper: ({
		disabled,
		tooltipText,
		children,
	}: {
		disabled: boolean;
		tooltipText: string;
		children: React.ReactNode;
	}) => createElement('div', {'data-tooltip': disabled ? tooltipText : undefined}, children),
}));
vi.mock('@app/features/ui/button/Button', () => ({
	Button: ({
		children,
		onClick,
		disabled,
		'aria-label': ariaLabel,
		'data-flx': flx,
	}: {
		children: React.ReactNode;
		onClick?: () => void;
		disabled?: boolean;
		'aria-label'?: string;
		'data-flx': string;
	}) =>
		createElement('button', {type: 'button', onClick, disabled, 'aria-label': ariaLabel, 'data-flx': flx}, children),
}));
vi.mock('@app/features/premium/components/PremiumHalo', () => ({
	PremiumHalo: ({size, children}: {size: string; children: React.ReactNode}) =>
		createElement('span', {'data-halo': size}, children),
}));
// Only the pushed dialog's type is checked; the real dialog loads the app runtime.
vi.mock('@app/features/shop/components/modals/ShopCheckoutModal', () => ({ShopCheckoutModal: () => null}));
vi.mock('@app/features/shop/components/modals/ShopBundleDetailModal', () => ({ShopBundleDetailModal: () => null}));

const clock = observable.box(Date.now());
const ModalCommands = await import('@app/features/ui/commands/ModalCommands');
const RouterUtils = await import('@app/features/navigation/utils/RouterUtils');
const {ShopCheckoutModal} = await import('@app/features/shop/components/modals/ShopCheckoutModal');
const {ShopBundleDetailModal} = await import('@app/features/shop/components/modals/ShopBundleDetailModal');
const {ShopBundleBuyButton, ShopBundleCard} = await import('@app/features/shop/components/ShopBundleCard');

const PRICE: ShopPriceResponse = {
	base_try_minor: 900,
	campaign_percent: null,
	campaign_ends_at: null,
	sale_try_minor: 900,
	premium_try_minor: 630,
};

function item(id: string, type: CosmeticItemResponse['type']): CosmeticItemResponse {
	return {id, type, name: `item ${id}`, description: null, asset: `hash${id}`, availability: 'owned'};
}

const ENTRY: ShopBundleEntry = {
	kind: 'bundle',
	sku: 'bundle:70',
	bundle: {
		sku: 'bundle:70',
		id: '70',
		name: 'Gece seti',
		description: null,
		items: [item('1', 'avatar_decoration'), item('2', 'profile_effect')],
		price: PRICE,
	},
	price: PRICE,
};

describe('ShopBundleCard', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.clearAllMocks();
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(state, {
			settings: SETTINGS,
			premiumDiscount: false,
			owned: new Set(),
			claimed: true,
			verified: true,
			hovering: false,
			itemEntries: [],
		});
		stages.length = 0;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const render = (opensDetails = false) =>
		act(() => root.render(createElement(ShopBundleCard, {entry: ENTRY, opensDetails})));
	const part = (name: string) =>
		container.querySelector(`[data-flx="shop.shop-price-line.${name}"]`)?.textContent ?? null;
	const action = () => container.querySelector<HTMLButtonElement>('[data-flx^="shop.shop-bundle-card.button.action"]');
	const pushed = () =>
		(vi.mocked(ModalCommands.push).mock.calls.at(-1)![0] as unknown as () => ReactElement<{target: unknown}>)();

	it('shows the item count with the name and the price and passes every bundle item to the grid stage', () => {
		render();

		expect(container.querySelector('[data-flx="shop.shop-bundle-card.name"]')?.textContent).toBe('2-piece Gece seti');
		expect(part('final')).toBe('₺9');
		expect(part('premium')).toBeNull();
		// Every item of the bundle at once on the card's art.
		expect(stages.at(-1)).toMatchObject({
			items: ENTRY.bundle.items,
			size: 'grid',
			composed: true,
			animateNameplate: false,
		});
	});

	it('passes hover to the grid stage animation control', () => {
		const plated = {...ENTRY, bundle: {...ENTRY.bundle, items: [...ENTRY.bundle.items, item('3', 'nameplate')]}};
		act(() => root.render(createElement(ShopBundleCard, {entry: plated})));
		expect(stages.at(-1)?.animateNameplate).toBe(false);

		// A new entry object: the card is a memoised observer and skips a render with the same props.
		state.hovering = true;
		act(() => root.render(createElement(ShopBundleCard, {entry: {...plated}})));
		expect(stages.at(-1)?.animateNameplate).toBe(true);
	});

	it('sells on the item sales switch, not the premium one, and shows a member their price', () => {
		state.premiumDiscount = true;
		render();

		expect(part('final')).toBe('₺6.30');
		expect(part('was')).toBe('₺9');
		expect(action()?.textContent).toBe('Buy for ₺6.30');
		expect(action()?.getAttribute('aria-label')).toBe('Buy Gece seti');
		expect(action()).not.toBeNull();
	});

	const savings = () => container.querySelector('[data-flx="shop.shop-bundle-card.savings"]')?.textContent ?? null;
	const priced = (id: string, cents: number): ShopItemEntry => ({
		kind: 'item',
		sku: `cosmetic:${id}`,
		item: item(id, 'avatar_decoration'),
		price: {...PRICE, base_try_minor: cents, sale_try_minor: cents},
	});

	it('shows what the bundle saves against its items bought one by one, beside the price only', () => {
		state.itemEntries = [priced('1', 600), priced('2', 600)];
		render();
		expect(savings()).toBe('-25%');
		expect(container.querySelector('[data-flx="shop.shop-bundle-card.savings-label"]')?.textContent).toBe(
			'Discount -25%',
		);

		state.owned = new Set(['1', '2']);
		act(() => root.render(createElement('div', null, createElement(ShopBundleCard, {entry: ENTRY}))));
		expect(savings()).toBeNull();
	});

	it('when a campaign ends, the price, the buy button and the saving change together without a new mount', () => {
		const end = Date.now() + 60_000;
		const sale = (cents: number) => ({
			...PRICE,
			premium_try_minor: null,
			base_try_minor: cents,
			sale_try_minor: cents / 2,
			campaign_percent: 50,
			campaign_ends_at: new Date(end).toISOString(),
		});
		const items = ['1', '2'].map((id) => ({
			...priced(id, 600),
			price: {...PRICE, base_try_minor: 600, sale_try_minor: 600},
		}));
		state.itemEntries = items;
		const onSale = {...ENTRY, price: sale(1000), bundle: {...ENTRY.bundle, price: sale(1000)}};
		runInAction(() => clock.set(end - 1000));
		act(() => root.render(createElement(ShopBundleCard, {entry: onSale})));
		expect(part('final')).toBe('₺5');
		expect(action()?.textContent).toBe('Buy for ₺5');
		expect(savings()).toBe('-58%');

		act(() => runInAction(() => clock.set(end + 1000)));
		expect(part('final')).toBe('₺10');
		expect(action()?.textContent).toBe('Buy for ₺10');
		expect(savings()).toBe('-16%');
		runInAction(() => clock.set(Date.now()));
	});

	it('shows no saving when an item has no price of its own', () => {
		state.itemEntries = [priced('1', 600)];
		render();
		expect(savings()).toBeNull();
	});

	it('opens its set page from the card, and the bundle dialog on that page', () => {
		render();
		act(() =>
			container.querySelector<HTMLButtonElement>('[data-flx="shop.shop-bundle-card.card-button.open"]')!.click(),
		);
		expect(RouterUtils.transitionTo).toHaveBeenCalledWith('/shop?set=70');
		expect(ModalCommands.pushWithKey).not.toHaveBeenCalled();
		// Back on the shop, the focus returns here.
		expect(
			container
				.querySelector('[data-flx="shop.shop-bundle-card.card-button.open"]')
				?.getAttribute('data-shop-set-opener'),
		).toBe('70');
	});

	// Preview and checkout are separate actions, including when purchase is unavailable.
	it('opens checkout from Purchase and, on the set page, a preview from the card', () => {
		render(true);
		expect(action()?.closest('[data-halo]')?.getAttribute('data-halo')).toBe('small');
		expect(
			container.querySelector('[data-flx="shop.shop-bundle-card.card-button.open"]')?.closest('[data-halo]'),
		).toBeNull();
		act(() => action()!.click());

		expect(pushed().type).toBe(ShopCheckoutModal);
		expect(pushed().props.target).toEqual({kind: 'bundle', sku: 'bundle:70'});

		act(() =>
			container.querySelector<HTMLButtonElement>('[data-flx="shop.shop-bundle-card.card-button.open"]')!.click(),
		);

		expect(ModalCommands.push).toHaveBeenCalledTimes(1);
		const preview = (
			vi.mocked(ModalCommands.pushWithKey).mock.calls[0][0] as unknown as () => ReactElement<{entry: ShopBundleEntry}>
		)();
		expect(preview.type).toBe(ShopBundleDetailModal);
		expect(preview.props.entry).toBe(ENTRY);
	});

	// Owned, partly owned and unsold bundles remain previewable without exposing checkout.
	it.each([
		[{owned: new Set(['2'])}],
		[{owned: new Set(['1', '2'])}],
		[{settings: {...SETTINGS, premium_sales_open: true, item_sales_open: false}}],
	])('opens preview but no checkout when there is nothing to buy: %o', (fields) => {
		Object.assign(state, fields);
		render(true);
		act(() =>
			container.querySelector<HTMLButtonElement>('[data-flx="shop.shop-bundle-card.card-button.open"]')!.click(),
		);

		expect(ModalCommands.push).not.toHaveBeenCalled();
		expect(ModalCommands.pushWithKey).toHaveBeenCalledOnce();
	});

	it('says an item is already there and offers no purchase (E1)', () => {
		state.owned = new Set(['2']);
		render();

		expect(part('status')).toBe('You already own an item in this bundle');
		expect(action()).toBeNull();
		expect(container.querySelector('[data-halo]')).toBeNull();

		state.owned = new Set(['1', '2']);
		act(() => root.render(createElement('div', null, createElement(ShopBundleCard, {entry: ENTRY}))));

		expect(part('status')).toBe('Owned');
		expect(action()).toBeNull();
	});

	it('is not on sale while item sales are closed', () => {
		state.settings = {...SETTINGS, premium_sales_open: true, item_sales_open: false};
		render();

		expect(part('status')).toBe('Not on sale');
		expect(action()).toBeNull();
	});

	it.each([
		[{verified: false}, 'Verify your email to buy.'],
		[{claimed: false}, 'Claim your account to buy.'],
	])('disables Purchase with its reason for %o', (fields, reason) => {
		Object.assign(state, fields);
		render();

		expect(action()?.disabled).toBe(true);
		expect(action()?.closest('[data-halo]')).toBeNull();
		expect(container.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')).toBe(reason);
	});

	it('a buyable card leaves its action in the page for the keyboard and marks the card for the hover swap', () => {
		render();
		const card = container.querySelector('[data-flx="shop.shop-bundle-card.card"]');
		expect(action()).not.toBeNull();
		expect(action()?.getAttribute('tabindex')).toBeNull();
		expect(action()?.closest('[aria-hidden], [inert]')).toBeNull();
		expect(card?.className).toMatch(/hasAction/);

		state.owned = new Set(['2']);
		act(() => root.render(createElement('div', null, createElement(ShopBundleCard, {entry: ENTRY}))));
		expect(action()).toBeNull();
		expect(container.querySelector('[data-flx="shop.shop-bundle-card.card"]')?.className).not.toMatch(/hasAction/);
	});
});

// The collection header's "Buy <set>": the bundle card's own purchase, under the same rules.
describe('ShopBundleBuyButton', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.clearAllMocks();
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(state, {settings: SETTINGS, owned: new Set(), claimed: true, verified: true});
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	// A new parent each time: the button is a memoised observer over plain mocked stores.
	const render = () =>
		act(() => root.render(createElement('div', null, createElement(ShopBundleBuyButton, {entry: ENTRY}))));
	const button = () => container.querySelector<HTMLButtonElement>('button');

	it('opens the same bundle checkout as the card', () => {
		render();
		expect(button()?.textContent).toBe('Buy all: Gece seti');
		expect(button()?.disabled).toBe(false);
		act(() => button()!.click());
		const opened = (
			vi.mocked(ModalCommands.push).mock.calls.at(-1)![0] as unknown as () => ReactElement<{target: unknown}>
		)();
		expect(opened.type).toBe(ShopCheckoutModal);
		expect(opened.props.target).toEqual({kind: 'bundle', sku: 'bundle:70'});
	});

	it.each([
		[{owned: new Set(['2'])}],
		[{owned: new Set(['1', '2'])}],
		[{settings: {...SETTINGS, item_sales_open: false}}],
	])('is not there when the bundle cannot be bought: %o', (fields) => {
		Object.assign(state, fields);
		render();
		expect(button()).toBeNull();
	});

	it('is disabled with the reason for an account that may not buy yet', () => {
		state.verified = false;
		render();
		expect(button()?.disabled).toBe(true);
		expect(container.querySelector('[data-tooltip]')?.getAttribute('data-tooltip')).toBe('Verify your email to buy.');
		act(() => button()!.click());
		expect(ModalCommands.push).not.toHaveBeenCalled();
	});
});
