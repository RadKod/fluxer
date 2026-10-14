// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';

export interface ShopCollection {
	id: string;
	bundle: ShopBundleEntry | null;
	entries: Array<ShopBundleEntry | ShopItemEntry>;
}

// The input items already satisfy the storefront visibility rule. A shared item belongs to the first bundle.
export function buildShopCollections(
	items: ReadonlyArray<ShopItemEntry>,
	bundles: ReadonlyArray<ShopBundleEntry>,
	filter: 'all' | CosmeticType,
): Array<ShopCollection> {
	const remaining = new Map(items.map((entry) => [entry.item.id, entry]));
	const collections: Array<ShopCollection> = [];
	for (const bundle of bundles) {
		const entries: ShopCollection['entries'] = filter === 'all' ? [bundle] : [];
		for (const item of bundle.bundle.items) {
			const entry = remaining.get(item.id);
			if (!entry) continue;
			remaining.delete(item.id);
			if (filter === 'all' || entry.item.type === filter) entries.push(entry);
		}
		if (entries.length > 0) collections.push({id: bundle.sku, bundle, entries});
	}
	const entries = [...remaining.values()].filter((entry) => filter === 'all' || entry.item.type === filter);
	if (entries.length > 0) collections.push({id: 'other', bundle: null, entries});
	const entryOrder = (entry: ShopBundleEntry | ShopItemEntry) =>
		entry.kind === 'bundle' ? 0 : entry.item.type === 'avatar_ultra' ? 1 : 2;
	const ultraCollections: Array<ShopCollection> = [];
	const otherCollections: Array<ShopCollection> = [];
	for (const collection of collections) {
		collection.entries.sort((a, b) => entryOrder(a) - entryOrder(b));
		const hasUltra = collection.entries.some((entry) => entry.kind === 'item' && entry.item.type === 'avatar_ultra');
		(hasUltra ? ultraCollections : otherCollections).push(collection);
	}
	return [...ultraCollections, ...otherCollections];
}
