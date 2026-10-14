// SPDX-License-Identifier: AGPL-3.0-or-later

// sanalyer: the shop sells in Turkish lira only. Amounts are kuruş; a whole-lira price drops the decimals
// ("₺150"), any other shows two ("₺149,99", "₺149,50"). The locale decides separators and symbol position.
const formats = new Map<string, Intl.NumberFormat>();

function tryFormat(locale: string, fractionDigits: 0 | 2): Intl.NumberFormat {
	const key = `${locale}:${fractionDigits}`;
	let format = formats.get(key);
	if (!format) {
		format = new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: 'TRY',
			currencyDisplay: 'narrowSymbol',
			minimumFractionDigits: fractionDigits,
			maximumFractionDigits: fractionDigits,
		});
		formats.set(key, format);
	}
	return format;
}

export function formatShopTry(minor: number, locale: string): string {
	return tryFormat(locale, minor % 100 === 0 ? 0 : 2).format(minor / 100);
}
