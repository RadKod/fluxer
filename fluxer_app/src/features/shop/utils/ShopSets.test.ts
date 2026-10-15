// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopCollection} from '@app/features/shop/utils/ShopCollections';
import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import {
	buildShopSetCollection,
	bundleSavingsPercent,
	planShopFront,
	shopSetArtKey,
	shopSetPath,
} from '@app/features/shop/utils/ShopSets';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/app/Routes', () => ({Routes: {SHOP: '/shop'}}));

const NOW = Date.parse('2026-10-08T00:00:00Z');
const price = (base: number, sale = base, endsAt: string | null = null) => ({
	base_try_minor: base,
	sale_try_minor: sale,
	premium_try_minor: null,
	campaign_percent: sale === base ? null : Math.round((1 - sale / base) * 100),
	campaign_ends_at: endsAt,
});
const item = (id: string, cents: number | null): ShopItemEntry => ({
	kind: 'item',
	sku: `cosmetic:${id}`,
	item: {id, type: 'avatar_decoration', name: id, description: null, asset: id, availability: 'owned'},
	price: cents === null ? null : price(cents),
});
const bundle = (id: string, items: Array<ShopItemEntry>, bundlePrice = price(1000)): ShopBundleEntry => ({
	kind: 'bundle',
	sku: `bundle:${id}`,
	price: bundlePrice,
	bundle: {id, sku: `bundle:${id}`, name: id, description: null, items: items.map((e) => e.item), price: bundlePrice},
});
const collection = (entry: ShopBundleEntry | null, id = entry?.sku ?? 'other'): ShopCollection => ({
	id,
	bundle: entry,
	series: null,
	entries: entry ? [entry] : [],
});

describe('bundleSavingsPercent', () => {
	it('compares the bundle price with its items bought one by one', () => {
		const a = item('a', 599);
		const b = item('b', 599);
		expect(bundleSavingsPercent(bundle('x', [a, b], price(1099)), [a, b], NOW)).toBe(8);
	});
	it('uses the campaign price on both sides while the campaign runs', () => {
		const a = item('a', 1000);
		const sale = bundle('x', [a], price(1000, 800, '2026-10-09T00:00:00Z'));
		expect(bundleSavingsPercent(sale, [a], NOW)).toBe(20);
		const ended = bundle('x', [a], price(1000, 800, '2026-10-07T00:00:00Z'));
		expect(bundleSavingsPercent(ended, [a], NOW)).toBeNull();
	});
	it('says nothing when an item has no price of its own or the bundle saves nothing', () => {
		const a = item('a', 500);
		const bundleOnly = item('b', null);
		expect(bundleSavingsPercent(bundle('x', [a, bundleOnly], price(400)), [a, bundleOnly], NOW)).toBeNull();
		expect(bundleSavingsPercent(bundle('x', [a], price(500)), [a], NOW)).toBeNull();
		expect(bundleSavingsPercent(bundle('x', [item('c', 500)], price(400)), [], NOW)).toBeNull();
	});
});

describe('bundleSavingsPercent at the edges', () => {
	it('rounds down, so a paid bundle never reads 100%', () => {
		const a = item('a', 10_000_000);
		expect(bundleSavingsPercent(bundle('x', [a], price(600)), [a], NOW)).toBe(99);
		const b = item('b', 1000);
		expect(bundleSavingsPercent(bundle('x', [b], price(995)), [b], NOW)).toBeNull();
	});
});

describe('shopSetArtKey', () => {
	it('finds the art of a known set by its name, in either language', () => {
		expect(shopSetArtKey('Angel Wings')).toBe('angel-wings');
		expect(shopSetArtKey('Kuzgun Wings Paketi')).toBe('kuzgun');
		expect(shopSetArtKey('PAYIZ')).toBe('sonbahar');
		expect(shopSetArtKey('Kara Ejder')).toBe('kara-ejder');
		expect(shopSetArtKey('Sakura')).toBe('sakura');
	});
	it('has no art for an unknown set', () => {
		expect(shopSetArtKey('Gece Tacı')).toBeNull();
	});
});

describe('planShopFront', () => {
	it('features the first set, promotes the next two and keeps the rest as rows', () => {
		const sets = ['a', 'b', 'c', 'd'].map((id) => collection(bundle(id, [])));
		const other = collection(null);
		const plan = planShopFront([sets[0], other, sets[1], sets[2], sets[3]]);
		expect(plan.featured?.id).toBe('bundle:a');
		expect(plan.promos.map((c) => c.id)).toEqual(['bundle:b', 'bundle:c']);
		expect(plan.rows.map((c) => c.id)).toEqual(['other', 'bundle:d']);
	});
	it('leaves everything in rows when no collection is a set', () => {
		const other = collection(null);
		expect(planShopFront([other])).toEqual({featured: null, promos: [], rows: [other]});
	});
});

describe('shopSetPath', () => {
	it('opens the set page on the shop route', () => {
		expect(shopSetPath('1234')).toBe('/shop?set=1234');
	});
});

describe('buildShopSetCollection', () => {
	it("holds every item of the set that is sold on its own, even one another set's row already shows", () => {
		const shared = item('shared', 500);
		const onlyB = item('only-b', 500);
		const bundleOnly = item('bundle-only', null);
		const b = bundle('b', [shared, onlyB, bundleOnly]);
		const set = buildShopSetCollection(b, [shared, onlyB]);
		expect(set.bundle).toBe(b);
		expect(set.entries.map((entry) => entry.sku)).toEqual(['bundle:b', 'cosmetic:shared', 'cosmetic:only-b']);
	});
});
