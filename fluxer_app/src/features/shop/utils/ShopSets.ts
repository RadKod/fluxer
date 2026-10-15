// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import type {ShopCollection} from '@app/features/shop/utils/ShopCollections';
import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import {shownTryMinor} from '@app/features/shop/utils/ShopPriceFormat';

const PROMO_COUNT = 2;

// A set page is the shop route with the set's bundle ID in the query, so the back button and links work as usual.
export const SHOP_SET_QUERY = 'set';

export function shopSetPath(bundleId: string): string {
	return `${Routes.SHOP}?${new URLSearchParams({[SHOP_SET_QUERY]: bundleId})}`;
}

// What the bundle saves against its items bought one by one, in whole percent, from the catalog's own prices (the
// campaign price on both sides while one runs). Null when an item has no price of its own or nothing is saved.
export function bundleSavingsPercent(
	entry: ShopBundleEntry,
	items: ReadonlyArray<ShopItemEntry>,
	now: number,
): number | null {
	const prices = new Map(items.map(({item, price}) => [item.id, price]));
	let total = 0;
	for (const item of entry.bundle.items) {
		const price = prices.get(item.id);
		if (!price) return null;
		total += shownTryMinor(price, now);
	}
	const bundlePrice = shownTryMinor(entry.price, now);
	if (total <= 0 || bundlePrice <= 0) return null;
	// Rounded down: a paid bundle never reads 100%, and no saving is promised beyond the prices.
	const percent = Math.floor(((total - bundlePrice) * 100) / total);
	return percent > 0 ? percent : null;
}

// TEMPORARY: set art is matched by the bundle's name to images shipped with the client. Target: a banner image on
// the bundle record, uploaded from admin and served by the CDN. Move when a set has to appear without a client
// release, or once there are more than 10 sets.
const SET_ART_KEYS: ReadonlyArray<[RegExp, string]> = [
	[/angel/i, 'angel-wings'],
	[/kuzgun|raven/i, 'kuzgun'],
	[/sakura/i, 'sakura'],
	[/sonbahar|payız|payiz|autumn/i, 'sonbahar'],
	[/neon/i, 'neon'],
	[/kedi|cat\b/i, 'kedi'],
	[/ejder|dragon/i, 'kara-ejder'],
];

export function shopSetArtKey(name: string): string | null {
	return SET_ART_KEYS.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

// A set's page: its bundle, then every item of the bundle that is on display on its own, in bundle order. Built from
// the bundle itself, not from the front page's rows, which show an item shared by two sets only once.
export function buildShopSetCollection(
	entry: ShopBundleEntry,
	items: ReadonlyArray<ShopItemEntry>,
): ShopCollection & {bundle: ShopBundleEntry} {
	const onDisplay = new Map(items.map((item) => [item.item.id, item]));
	return {
		id: entry.sku,
		bundle: entry,
		series: null,
		entries: [entry, ...entry.bundle.items.flatMap((item) => onDisplay.get(item.id) ?? [])],
	};
}

export interface ShopFrontPlan {
	// The hero's set: the first collection that is a set.
	featured: ShopCollection | null;
	// The next sets, as tiles that open their set page.
	promos: Array<ShopCollection>;
	// Everything else, as rows, in catalog order.
	rows: Array<ShopCollection>;
}

export function planShopFront(collections: ReadonlyArray<ShopCollection>): ShopFrontPlan {
	const sets = collections.filter((collection) => collection.bundle !== null);
	const featured = sets[0] ?? null;
	const promos = sets.slice(1, 1 + PROMO_COUNT);
	const taken = new Set([featured, ...promos]);
	return {featured, promos, rows: collections.filter((collection) => !taken.has(collection))};
}
