// SPDX-License-Identifier: AGPL-3.0-or-later

let cachedLocale: string | null = null;
let tryFormat: Intl.NumberFormat;
let aznFormat: Intl.NumberFormat;

function cacheFormats(locale: string): void {
	if (locale === cachedLocale) return;
	tryFormat = new Intl.NumberFormat(locale, {minimumFractionDigits: 0, maximumFractionDigits: 2});
	aznFormat = new Intl.NumberFormat(locale, {minimumFractionDigits: 2, maximumFractionDigits: 2});
	cachedLocale = locale;
}

export function formatShopTry(minor: number, locale: string): string {
	cacheFormats(locale);
	return `${tryFormat.format(minor / 100)} TL`;
}

export function formatShopAzn(minor: number, locale: string): string {
	cacheFormats(locale);
	return aznFormat.format(minor / 100);
}
