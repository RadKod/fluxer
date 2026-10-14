// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopPackageEntry} from '@app/features/shop/utils/ShopEntries';
import {shownCents} from '@app/features/shop/utils/ShopPriceFormat';

// What a package's month saves against the one month package, in whole percent rounded down, from the prices on sale
// now (a running campaign counts on either side). Null for the one month package itself, without one, for a package
// without a price, or when nothing is saved.
export function planSavingsPercent(
	entry: ShopPackageEntry,
	entries: ReadonlyArray<ShopPackageEntry>,
	now: number,
): number | null {
	if (entry.months === 1) return null;
	const month = entries.find((candidate) => candidate.months === 1);
	if (!month) return null;
	const monthCents = shownCents(month.price, now);
	const cents = shownCents(entry.price, now);
	if (monthCents <= 0 || cents <= 0) return null;
	// Rounded down: a paid plan never reads 100%, and no saving is promised beyond the prices.
	const whole = entry.months * monthCents;
	const percent = Math.floor(((whole - cents) * 100) / whole);
	return percent > 0 ? percent : null;
}

// The plan card's picture: the year has its own, the shorter packages share the month's.
export function planArt(months: 1 | 3 | 12): 'month' | 'year' {
	return months === 12 ? 'year' : 'month';
}
