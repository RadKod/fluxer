// SPDX-License-Identifier: AGPL-3.0-or-later

import {getCachedNumberFormat} from '@app/features/i18n/utils/IntlCache';
import {formatShopTry} from '@fluxer/schema/src/domains/shop/ShopPriceFormatting';
import type {ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';

// sanalyer: the shop sells in Turkish lira only; every price is kuruş formatted as "₺150" / "₺149,99".
export function formatTry(minor: number, locale: string): string {
	return formatShopTry(minor, locale);
}

// TR "-%20", EN "-20%".
export function formatDiscount(percent: number, locale: string): string {
	return getCachedNumberFormat(locale, {style: 'percent'}).format(-percent / 100);
}

// One step of the server's computeShopPrice: `percent` off, rounded half up.
export function percentOff(minor: number, percent: number): number {
	return Math.floor((2 * minor * (100 - percent) + 100) / 200);
}

// Card prices are display only. A campaign shows until its end on the server clock; the server enforces the end.
export function campaignShown(price: ShopPriceResponse, now: number): boolean {
	return (
		price.campaign_percent !== null && (price.campaign_ends_at === null || Date.parse(price.campaign_ends_at) > now)
	);
}

// The price a card shows now: the campaign price while the campaign shows, the list price otherwise.
export function shownTryMinor(price: ShopPriceResponse, now: number): number {
	return campaignShown(price, now) ? price.sale_try_minor : price.base_try_minor;
}
