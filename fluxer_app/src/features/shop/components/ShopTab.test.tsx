// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopSettingsResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type React from 'react';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function interpolate(descriptor: {message: string}, values: Record<string, unknown> = {}): string {
	return descriptor.message.replace(/{(\w+)}/g, (token, key: string) => (key in values ? String(values[key]) : token));
}

const SETTINGS: ShopSettingsResponse = {
	premium_sales_open: true,
	item_sales_open: true,
	premium_discount_percent: 30,
	usd_to_azn_rate: '1.7000',
};

const catalog = vi.hoisted(() => ({
	status: 'ready' as 'idle' | 'loading' | 'ready' | 'failed',
	settings: null as ShopSettingsResponse | null,
	itemEntries: [] as Array<ShopItemEntry>,
	bundleEntries: [] as Array<ShopBundleEntry>,
	load: vi.fn(async (_force?: boolean) => {}),
}));
const cosmetics = vi.hoisted(() => ({ready: true, failed: false, load: vi.fn(async () => {})}));
const runtime = vi.hoisted(() => ({isSelfHosted: () => true, giftCodesEnabled: true}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: interpolate}}),
	Trans: ({children}: {children: React.ReactNode}) => children,
}));
vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: runtime}));
vi.mock('@app/features/shop/state/ShopCatalog', () => ({default: catalog}));
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({
	COSMETIC_TYPES: ['avatar_decoration', 'avatar_ultra', 'nameplate', 'profile_effect'],
	default: cosmetics,
}));
vi.mock('@app/features/cosmetics/state/UltraLayouts', () => ({default: {prime: vi.fn()}}));
// The code field and the hero have their own tests; here they only show whether and where the page draws them.
vi.mock('@app/features/shop/components/ShopRedeemField', () => ({
	ShopRedeemField: ({variant, inputId}: {variant: string; inputId: string}) =>
		createElement('form', {'data-redeem': variant, id: inputId}),
}));
vi.mock('@app/app/Routes', () => ({Routes: {SHOP: '/shop'}}));
// The art, the tiles and the set page have their own tests; here they only show where the page puts them.
vi.mock('@app/features/shop/components/ShopSetArt', () => ({
	ShopSetArt: ({entry, front}: {entry: ShopBundleEntry; front?: boolean}) =>
		createElement('div', {'data-art': entry.sku, 'data-front': front ? 'true' : undefined}),
	ShopSetTile: ({entry}: {entry: ShopBundleEntry}) =>
		createElement(
			'section',
			{'data-tile': entry.sku},
			createElement('button', {type: 'button', 'data-shop-set-opener': entry.bundle.id}),
		),
}));
vi.mock('@app/features/shop/components/ShopSetView', () => ({
	ShopSetView: ({collection}: {collection: {bundle: ShopBundleEntry; entries: Array<{sku: string}>}}) =>
		createElement('div', {
			'data-set-view': collection.bundle.sku,
			'data-entries': collection.entries.map((entry) => entry.sku).join(','),
		}),
}));
// The card has its own test; here it only shows which entries the page lays out, and where.
vi.mock('@app/features/shop/components/ShopItemCard', () => ({
	ShopItemCard: ({entry}: {entry: ShopItemEntry}) => createElement('div', {'data-card': entry.item.id}),
}));
vi.mock('@app/features/shop/components/ShopBundleCard', () => ({
	ShopBundleCard: ({entry}: {entry: ShopBundleEntry}) => createElement('div', {'data-card': entry.sku}),
	ShopBundleBuyButton: ({entry, variant}: {entry: ShopBundleEntry; variant?: string}) =>
		createElement('button', {type: 'button', 'data-buy-bundle': entry.sku, 'data-variant': variant}),
}));
vi.mock('@app/features/app/components/dialogs/shared/StatusSlate', () => ({
	StatusSlate: ({
		title,
		description,
		actions = [],
	}: {
		title: string;
		description: string;
		actions?: Array<{text: string; onClick: () => void}>;
	}) =>
		createElement(
			'div',
			{'data-slate': title},
			description,
			actions.map((action) =>
				createElement('button', {key: action.text, type: 'button', onClick: action.onClick}, action.text),
			),
		),
}));
const {default: UltraLayouts} = await import('@app/features/cosmetics/state/UltraLayouts');
const {ShopTab} = await import('@app/features/shop/components/ShopTab');
type ShopFilter = import('@app/features/shop/components/ShopTab').ShopFilter;

function entry(
	id: string,
	type: CosmeticItemResponse['type'],
	availability: CosmeticItemResponse['availability'] = 'owned',
	priced = availability === 'owned',
): ShopItemEntry {
	return {
		kind: 'item',
		sku: `cosmetic:${id}`,
		item: {id, type, name: `item ${id}`, description: null, asset: `hash${id}`, availability},
		price: priced
			? {
					base_usd_cents: 500,
					campaign_percent: null,
					campaign_ends_at: null,
					sale_usd_cents: 500,
					premium_usd_cents: null,
				}
			: null,
	};
}

function bundle(id: string, items: Array<ShopItemEntry>): ShopBundleEntry {
	const price = items[0].price!;
	return {
		kind: 'bundle',
		sku: `bundle:${id}`,
		bundle: {
			sku: `bundle:${id}`,
			id,
			name: `bundle ${id}`,
			description: null,
			items: items.map(({item}) => item),
			price,
		},
		price,
	};
}

describe('ShopTab', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		vi.clearAllMocks();
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(catalog, {
			status: 'ready',
			settings: SETTINGS,
			itemEntries: [
				entry('41', 'avatar_ultra'),
				entry('11', 'avatar_decoration', 'premium'),
				entry('42', 'avatar_ultra', 'premium'),
				entry('31', 'profile_effect'),
			],
			bundleEntries: [],
		});
		Object.assign(cosmetics, {ready: true, failed: false});
		runtime.giftCodesEnabled = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});

	const draw = (filter: ShopFilter, setId: string | null) =>
		createElement(ShopTab, {filter, redeemInputId: 'shop-code', setId});
	const render = async (filter: ShopFilter = 'all', setId: string | null = null) => {
		await act(async () => root.render(draw(filter, setId)));
	};
	// A new parent makes the observer read the mocked state again.
	const rerender = async (filter: ShopFilter = 'all', setId: string | null = null) => {
		await act(async () => root.render(createElement('div', null, draw(filter, setId))));
	};
	const cards = () => [...container.querySelectorAll('[data-card]')].map((card) => card.getAttribute('data-card'));
	const headings = () => [...container.querySelectorAll('h2')].map((heading) => heading.textContent);
	const slate = () => container.querySelector('[data-slate]')?.getAttribute('data-slate') ?? null;
	const codeField = () => container.querySelector('[data-redeem]');
	const isAfter = (first: Element | null | undefined, second: Element | null) =>
		first != null &&
		second !== null &&
		(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

	it('loads the catalog and the owned items, and primes the ultra sizes from the catalog', async () => {
		await render();
		expect(catalog.load).toHaveBeenCalled();
		expect(cosmetics.load).toHaveBeenCalled();
		expect(UltraLayouts.prime).toHaveBeenCalledWith(catalog.itemEntries.map(({item}) => item));
	});

	it('primes the ultra sizes of bundle items too, which the items list may not have', async () => {
		catalog.bundleEntries = [bundle('70', [entry('45', 'avatar_ultra'), entry('32', 'profile_effect')])];
		await render();
		expect(UltraLayouts.prime).toHaveBeenCalledWith([
			...catalog.itemEntries.map(({item}) => item),
			...catalog.bundleEntries[0].bundle.items,
		]);
	});

	it('shows bundle previews only under "All", the first set featured at the top', async () => {
		catalog.bundleEntries = [bundle('70', [entry('45', 'avatar_ultra'), entry('32', 'profile_effect')])];
		await render();
		expect(container.querySelector('h1')?.textContent).toBe('bundle 70');
		expect(headings()).toEqual(['Other']);
		expect(cards()).toEqual(['bundle:70', '41', '42', '11', '31']);

		await rerender('avatar_ultra');
		expect(headings()).toEqual(['Other']);
		expect(cards()).toEqual(['41', '42']);
	});

	it("a bundle's collection offers the bundle in its header, the Other collection offers nothing", async () => {
		const shared = entry('41', 'avatar_ultra');
		catalog.itemEntries = [shared, entry('31', 'profile_effect')];
		catalog.bundleEntries = [bundle('70', [shared])];
		await render();
		const [bundleSection, otherSection] = [...container.querySelectorAll('[data-flx="shop.shop-tab.section"]')];
		expect(bundleSection.querySelector('[data-buy-bundle]')?.getAttribute('data-buy-bundle')).toBe('bundle:70');
		expect(bundleSection.querySelector('h1')?.contains(bundleSection.querySelector('[data-buy-bundle]'))).toBe(false);
		expect(otherSection.querySelector('h2')?.textContent).toBe('Other');
		expect(otherSection.querySelector('[data-buy-bundle]')).toBeNull();
	});

	it('a shop with only bundles on sale is not empty', async () => {
		catalog.itemEntries = [entry('43', 'avatar_ultra', 'free')];
		catalog.bundleEntries = [bundle('70', [entry('45', 'avatar_ultra'), entry('32', 'profile_effect')])];
		await render();
		expect(slate()).toBeNull();
		expect(cards()).toEqual(['bundle:70']);

		await rerender('nameplate');
		expect(slate()).toBe('Nothing on sale right now');
	});

	it('draws standalone items in one Other collection with ultras first', async () => {
		catalog.itemEntries = [...catalog.itemEntries, entry('21', 'nameplate')];
		await render();
		expect(headings()).toEqual(['Other']);
		expect(cards()).toEqual(['41', '42', '11', '31', '21']);
		expect(container.querySelector('[role="tab"]')).toBeNull();
		expect(container.textContent).not.toContain('Dress up your profile');
	});

	it('orders every cosmetic type for the page bar and the sections, ultras first', async () => {
		const {SHOP_TYPE_ORDER} = await import('@app/features/shop/components/ShopTab');
		const {COSMETIC_TYPES} = await import('@app/features/cosmetics/state/Cosmetics');
		expect(SHOP_TYPE_ORDER).toEqual(['avatar_ultra', 'avatar_decoration', 'nameplate', 'profile_effect']);
		expect([...SHOP_TYPE_ORDER].sort()).toEqual([...COSMETIC_TYPES].sort());
	});

	it('the filter comes from the page bar and keeps only its section', async () => {
		await render('avatar_ultra');
		expect(headings()).toEqual(['Other']);
		expect(cards()).toEqual(['41', '42']);

		await rerender('nameplate');
		expect(cards()).toEqual([]);
		expect(slate()).toBe('Nothing on sale right now');
		expect(codeField()).not.toBeNull();
	});

	it('hides free and unpriced items', async () => {
		catalog.itemEntries = [
			entry('41', 'avatar_ultra'),
			entry('43', 'avatar_ultra', 'free'),
			entry('44', 'nameplate', 'owned', false),
		];
		await render();
		expect(cards()).toEqual(['41']);
	});

	it('the code bar comes after the last section', async () => {
		await render();
		expect(codeField()?.getAttribute('data-redeem')).toBe('bar');
		expect(codeField()?.id).toBe('shop-code');
		expect(isAfter([...container.querySelectorAll('[data-card]')].at(-1), codeField())).toBe(true);
	});

	it('shows the paused note when item sales are closed and keeps the code bar', async () => {
		await render();
		expect(container.textContent).not.toContain('Sales are paused right now.');
		catalog.settings = {...SETTINGS, item_sales_open: false};
		await rerender();
		expect(container.textContent).toContain('Sales are paused right now. Items you own can still be equipped.');
		expect(codeField()).not.toBeNull();
		expect(cards()).toHaveLength(4);
	});

	it('shows eight skeleton cards while loading, with the code bar under them', async () => {
		catalog.status = 'loading';
		await render();
		const skeletons = container.querySelectorAll('[data-flx="shop.shop-tab.skeleton-card"]');
		expect(skeletons).toHaveLength(8);
		expect(cards()).toEqual([]);
		expect(isAfter(skeletons[7], codeField())).toBe(true);
	});

	it('empty and error slates keep the code bar under them', async () => {
		catalog.itemEntries = [entry('43', 'avatar_ultra', 'free')];
		await render();
		expect(slate()).toBe('Nothing on sale right now');
		expect(isAfter(container.querySelector('[data-slate]'), codeField())).toBe(true);

		catalog.status = 'failed';
		await rerender();
		expect(slate()).toBe('Something went wrong');
		expect(isAfter(container.querySelector('[data-slate]'), codeField())).toBe(true);
		vi.clearAllMocks();
		act(() =>
			[...container.querySelectorAll<HTMLButtonElement>('[data-slate] button')]
				.find((button) => button.textContent === 'Try again')
				?.click(),
		);
		expect(catalog.load).toHaveBeenCalledWith(true);
		expect(cosmetics.load).toHaveBeenCalled();
	});

	it('with gift codes off there is no code bar', async () => {
		runtime.giftCodesEnabled = false;
		await render();
		expect(codeField()).toBeNull();
		catalog.status = 'failed';
		await rerender();
		expect(codeField()).toBeNull();
	});

	const art = () => container.querySelector('[data-art]');
	const tiles = () => [...container.querySelectorAll('[data-tile]')].map((tile) => tile.getAttribute('data-tile'));

	it('features the first set over the shop art, with its purchase as the light button', async () => {
		catalog.bundleEntries = [bundle('70', [entry('41', 'avatar_ultra')])];
		await render();
		expect(art()?.getAttribute('data-front')).toBe('true');
		const hero = container.querySelector('[data-hero]');
		expect(hero?.querySelector('h1')?.textContent).toBe('bundle 70');
		expect(hero?.querySelector('[data-buy-bundle]')?.getAttribute('data-variant')).toBe('inverted');
		expect(isAfter(art(), hero)).toBe(true);
	});

	it('the next two sets become tiles to their pages, the others stay rows', async () => {
		catalog.itemEntries = [];
		catalog.bundleEntries = ['70', '71', '72', '73'].map((id) => bundle(id, [entry(`${id}1`, 'avatar_decoration')]));
		await render();
		expect(container.querySelector('h1')?.textContent).toBe('bundle 70');
		expect(tiles()).toEqual(['bundle:71', 'bundle:72']);
		expect(headings()).toEqual(['bundle 73']);
		expect(cards()).toEqual(['bundle:70', 'bundle:73']);
		const rowSection = container.querySelector('[data-card="bundle:73"]')?.closest('section');
		expect(rowSection?.querySelector('[data-buy-bundle]')?.getAttribute('data-variant')).toBe('secondary');
	});

	it('a type filter shows plain rows: no art, no featured set, no tiles', async () => {
		catalog.bundleEntries = [bundle('70', [entry('41', 'avatar_ultra')]), bundle('71', [entry('42', 'avatar_ultra')])];
		await render('avatar_ultra');
		expect(art()).toBeNull();
		expect(tiles()).toEqual([]);
		expect(container.querySelector('h1')).toBeNull();
		expect(headings()).toEqual(['bundle 70', 'bundle 71']);
	});

	it('opens the page of the set named by its bundle ID, with every item of the set, whatever the filter', async () => {
		catalog.bundleEntries = [bundle('70', [entry('41', 'avatar_ultra'), entry('31', 'profile_effect')])];
		await render('nameplate', '70');
		const view = container.querySelector('[data-set-view]');
		expect(view?.getAttribute('data-set-view')).toBe('bundle:70');
		expect(view?.getAttribute('data-entries')).toBe('bundle:70,cosmetic:41,cosmetic:31');
		expect(cards()).toEqual([]);
		expect(codeField()).not.toBeNull();
	});

	it('back on the whole shop, the focus returns to what opened the set', async () => {
		catalog.itemEntries = [];
		catalog.bundleEntries = ['70', '71'].map((id) => bundle(id, [entry(`${id}1`, 'avatar_decoration')]));
		await render('all', '71');
		expect(container.querySelector('[data-set-view]')).not.toBeNull();
		await render('all', null);
		expect(document.activeElement).toBe(container.querySelector('[data-shop-set-opener="71"]'));
	});

	it('a set that is not sold any more shows the whole shop', async () => {
		catalog.bundleEntries = [bundle('70', [entry('41', 'avatar_ultra')])];
		await render('all', '99');
		expect(container.querySelector('[data-set-view]')).toBeNull();
		expect(container.querySelector('h1')?.textContent).toBe('bundle 70');
	});

	it('renders shared items once in their first collection and retains all bundle previews', async () => {
		const shared = entry('41', 'avatar_ultra');
		const plate = entry('21', 'nameplate');
		catalog.itemEntries = [shared, plate];
		catalog.bundleEntries = [bundle('70', [shared, plate]), bundle('71', [shared])];
		await render();
		expect(container.querySelector('h1')?.textContent).toBe('bundle 70');
		expect(tiles()).toEqual(['bundle:71']);
		expect(cards()).toEqual(['bundle:70', '41', '21']);
		await rerender('avatar_ultra');
		expect(headings()).toEqual(['bundle 70']);
		expect(cards()).toEqual(['41']);
	});
});
