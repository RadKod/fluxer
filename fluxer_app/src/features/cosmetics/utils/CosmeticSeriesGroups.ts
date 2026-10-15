// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {cosmeticSeriesSlug, normalizeCosmeticSeriesName} from '@fluxer/constants/src/CosmeticSeries';

// sanalyer: a series is the items that share a series slug. Groups come back in name order, Turkish collation,
// with the items that have no series last under slug "other" (name null; the caller labels it).
export interface CosmeticSeriesGroup<T extends CosmeticItemResponse> {
	slug: string;
	name: string | null;
	items: Array<T>;
}

export const OTHER_SERIES_SLUG = 'other';

export function groupCosmeticsBySeries<T extends CosmeticItemResponse>(
	items: ReadonlyArray<T>,
): Array<CosmeticSeriesGroup<T>> {
	const bySlug = new Map<string, CosmeticSeriesGroup<T>>();
	const other: CosmeticSeriesGroup<T> = {slug: OTHER_SERIES_SLUG, name: null, items: []};
	for (const item of items) {
		const slug = cosmeticSeriesSlug(item.series);
		if (slug === null) {
			other.items.push(item);
			continue;
		}
		let group = bySlug.get(slug);
		if (!group) {
			group = {slug, name: normalizeCosmeticSeriesName(item.series), items: []};
			bySlug.set(slug, group);
		}
		group.items.push(item);
	}
	const groups = [...bySlug.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'tr'));
	return other.items.length > 0 ? [...groups, other] : groups;
}

// Case- and accent-insensitive match on the name or the series, so "jujutsu" finds "Jujutsu Kaisen".
export function cosmeticMatchesQuery(item: CosmeticItemResponse, query: string): boolean {
	const needle = cosmeticSeriesSlug(query);
	if (needle === null) return true;
	const name = cosmeticSeriesSlug(item.name) ?? '';
	const series = cosmeticSeriesSlug(item.series) ?? '';
	return name.includes(needle) || series.includes(needle);
}
