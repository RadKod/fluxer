// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import {cosmeticSeriesSlug, normalizeCosmeticSeriesName} from '@fluxer/constants/src/CosmeticSeries';

export interface ShopCollection {
	id: string;
	bundle: ShopBundleEntry | null;
	// sanalyer: the series name when the collection is a series row (items that share a series, outside any bundle).
	series: string | null;
	entries: Array<ShopBundleEntry | ShopItemEntry>;
}

// sanalyer: items outside every bundle are grouped by their series (slug of the name), one row per series in name
// order; items without a series stay in the trailing "other" collection. The display name is the first item's.
function seriesCollections(entries: ReadonlyArray<ShopItemEntry>): Array<ShopCollection> {
	const bySlug = new Map<string, ShopCollection>();
	const other: ShopCollection = {id: 'other', bundle: null, series: null, entries: []};
	for (const entry of entries) {
		const slug = cosmeticSeriesSlug(entry.item.series);
		if (slug === null) {
			other.entries.push(entry);
			continue;
		}
		let collection = bySlug.get(slug);
		if (!collection) {
			collection = {
				id: `series:${slug}`,
				bundle: null,
				series: normalizeCosmeticSeriesName(entry.item.series),
				entries: [],
			};
			bySlug.set(slug, collection);
		}
		collection.entries.push(entry);
	}
	const series = [...bySlug.values()].sort((a, b) => (a.series ?? '').localeCompare(b.series ?? '', 'tr'));
	return other.entries.length > 0 ? [...series, other] : series;
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
		if (entries.length > 0) collections.push({id: bundle.sku, bundle, series: null, entries});
	}
	const entries = [...remaining.values()].filter((entry) => filter === 'all' || entry.item.type === filter);
	collections.push(...seriesCollections(entries));
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
