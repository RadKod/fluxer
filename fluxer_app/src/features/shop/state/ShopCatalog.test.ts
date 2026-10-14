// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {
	ShopBundleResponse,
	ShopCatalogResponse,
	ShopPriceResponse,
	ShopVisionaryResponse,
} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const http = vi.hoisted(() => ({get: vi.fn(), post: vi.fn()}));
const session = vi.hoisted(() => ({currentAccountKey: 'micup.test:me' as string | null}));

vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: session}));

const NOW = Date.parse('2026-09-28T20:00:00.000Z');
const PRICE: ShopPriceResponse = {
	base_try_minor: 500,
	campaign_percent: null,
	campaign_ends_at: null,
	sale_try_minor: 500,
	premium_try_minor: 350,
};
const VISIONARY: ShopVisionaryResponse = {
	sku: 'visionary',
	price: {...PRICE, base_try_minor: 9900, sale_try_minor: 9900, premium_try_minor: null},
	total: 100,
	remaining: 42,
	visible: true,
};

function item(id: string, availability: CosmeticItemResponse['availability']): CosmeticItemResponse {
	return {id, type: 'avatar_ultra', name: `item ${id}`, description: null, asset: `hash${id}`, availability};
}

// A bundle-only item has no price, so it is not in the items list: the bundle carries it.
const BUNDLE: ShopBundleResponse = {
	sku: 'bundle:70',
	id: '70',
	name: 'Gece seti',
	description: null,
	items: [item('71', 'owned'), item('11', 'owned')],
	price: {...PRICE, base_try_minor: 900, sale_try_minor: 900, premium_try_minor: 630},
};

function catalog(extra: Partial<ShopCatalogResponse> = {}): ShopCatalogResponse {
	return {
		settings: {
			premium_sales_open: true,
			item_sales_open: true,
			premium_discount_percent: 30,
		},
		items: [
			{item: item('11', 'owned'), price: PRICE},
			{item: item('12', 'premium'), price: null},
			{item: item('13', 'premium'), price: null},
		],
		packages: [{sku: 'premium:3', months: 3, price: {...PRICE, premium_try_minor: null}}],
		visionary: null,
		server_time: new Date(NOW).toISOString(),
		viewer: {premium_discount: false},
		...extra,
	};
}

let ShopCatalog: typeof import('@app/features/shop/state/ShopCatalog').default;

describe('ShopCatalog', () => {
	beforeEach(async () => {
		vi.stubGlobal('document', Object.assign(new EventTarget(), {visibilityState: 'visible'}));
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		http.get.mockReset();
		http.get.mockResolvedValue({body: catalog()});
		session.currentAccountKey = 'micup.test:me';
		vi.resetModules();
		ShopCatalog = (await import('@app/features/shop/state/ShopCatalog')).default;
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('loads once and reuses the catalog for five minutes', async () => {
		await Promise.all([ShopCatalog.load(), ShopCatalog.load()]);
		expect(http.get).toHaveBeenCalledTimes(1);
		expect(http.get).toHaveBeenCalledWith('/shop/catalog');
		expect(ShopCatalog.status).toBe('ready');

		vi.setSystemTime(NOW + 4 * 60_000);
		await ShopCatalog.load();
		expect(http.get).toHaveBeenCalledTimes(1);

		vi.setSystemTime(NOW + 5 * 60_000 + 1);
		await ShopCatalog.load();
		expect(http.get).toHaveBeenCalledTimes(2);

		await ShopCatalog.load(true);
		expect(http.get).toHaveBeenCalledTimes(3);
	});

	it('loads again for another account', async () => {
		await ShopCatalog.load();
		session.currentAccountKey = 'micup.test:other';
		await ShopCatalog.load();
		expect(http.get).toHaveBeenCalledTimes(2);
	});

	it('reloads the same user from another instance and adopts its viewer flag', async () => {
		await ShopCatalog.load();
		expect(ShopCatalog.premiumDiscount).toBe(false);
		session.currentAccountKey = 'mirror.test:me';
		http.get.mockResolvedValueOnce({body: catalog({viewer: {premium_discount: true}})});
		await ShopCatalog.load();
		expect(http.get).toHaveBeenCalledTimes(2);
		expect(ShopCatalog.premiumDiscount).toBe(true);
	});

	it('says a load failed and tries again on the next load', async () => {
		http.get.mockRejectedValueOnce(new Error('offline'));
		await ShopCatalog.load();
		expect(ShopCatalog.status).toBe('failed');

		await ShopCatalog.load();
		expect(ShopCatalog.status).toBe('ready');
		expect(http.get).toHaveBeenCalledTimes(2);
	});

	it('keeps a ready catalog when a reload in the background fails', async () => {
		await ShopCatalog.load();
		http.get.mockRejectedValueOnce(new Error('offline'));
		await ShopCatalog.load(true);

		expect(ShopCatalog.status).toBe('ready');
		expect(ShopCatalog.entryForSku('premium:3')).toMatchObject({months: 3});
	});

	// One timer for the whole catalog: whatever reads the clock (card prices, buy buttons, bundle savings) is drawn
	// again when the first shown campaign ends, without a timer per card.
	it('redraws what reads the clock when the first shown campaign ends', async () => {
		const sale = (ms: number): ShopPriceResponse => ({
			...PRICE,
			campaign_percent: 50,
			sale_try_minor: 250,
			campaign_ends_at: new Date(NOW + ms).toISOString(),
		});
		http.get.mockResolvedValue({
			body: catalog({
				items: [{item: item('11', 'owned'), price: sale(120_000)}],
				bundles: [{...BUNDLE, price: sale(60_000)}],
			}),
		});
		await ShopCatalog.load();
		const {autorun} = await import('mobx');
		let draws = 0;
		const stop = autorun(() => {
			ShopCatalog.now();
			draws++;
		});
		expect(draws).toBe(1);
		vi.advanceTimersByTime(59_000);
		expect(draws).toBe(1);
		vi.advanceTimersByTime(2_000);
		expect(draws).toBe(2);
		vi.advanceTimersByTime(60_000);
		expect(draws).toBe(3);
		vi.advanceTimersByTime(10 * 60_000);
		expect(draws).toBe(3);
		stop();
	});

	it('keeps the server clock offset', async () => {
		http.get.mockResolvedValue({body: catalog({server_time: new Date(NOW + 90_000).toISOString()})});
		await ShopCatalog.load();

		expect(ShopCatalog.serverTimeOffsetMs).toBe(90_000);
		vi.setSystemTime(NOW + 1_000);
		expect(ShopCatalog.now()).toBe(NOW + 91_000);
	});

	it('counts premium-included items', async () => {
		await ShopCatalog.load();
		expect(ShopCatalog.premiumIncludedCount).toBe(2);
	});

	it('takes the premium discount flag from the viewer field', async () => {
		await ShopCatalog.load();
		expect(ShopCatalog.premiumDiscount).toBe(false);

		http.get.mockResolvedValue({body: catalog({viewer: {premium_discount: true}})});
		await ShopCatalog.load(true);
		expect(ShopCatalog.premiumDiscount).toBe(true);
	});

	it('finds items and packages by their sku', async () => {
		await ShopCatalog.load();
		expect(ShopCatalog.entryForSku('cosmetic:11')).toEqual({
			kind: 'item',
			sku: 'cosmetic:11',
			item: item('11', 'owned'),
			price: PRICE,
		});
		expect(ShopCatalog.entryForSku('premium:3')).toMatchObject({kind: 'package', sku: 'premium:3', months: 3});
		expect(ShopCatalog.entryForSku('premium:12')).toBeNull();
	});

	it('finds bundles by their sku, with their items as the server sent them', async () => {
		http.get.mockResolvedValue({body: catalog({bundles: [BUNDLE]})});
		await ShopCatalog.load();

		const bundleEntry = {kind: 'bundle', sku: 'bundle:70', bundle: BUNDLE, price: BUNDLE.price};
		expect(ShopCatalog.bundleEntries).toEqual([bundleEntry]);
		expect(ShopCatalog.entryForSku('bundle:70')).toEqual(bundleEntry);
		expect(ShopCatalog.entryForSku('bundle:71')).toBeNull();
		expect(ShopCatalog.entryForSku('cosmetic:71')).toBeNull();
	});

	it('reads a catalog without bundles as none', async () => {
		await ShopCatalog.load();
		expect(ShopCatalog.bundleEntries).toEqual([]);
	});

	it('keeps the Visionary block apart from the shop entries', async () => {
		http.get.mockResolvedValue({body: catalog({visionary: VISIONARY})});
		await ShopCatalog.load();

		expect(ShopCatalog.visionary).toEqual(VISIONARY);
		expect(ShopCatalog.entryForSku('visionary')).toBeNull();
		expect([...ShopCatalog.itemEntries, ...ShopCatalog.packageEntries].map((entry) => entry.sku)).toEqual([
			'cosmetic:11',
			'cosmetic:12',
			'cosmetic:13',
			'premium:3',
		]);
	});
});
