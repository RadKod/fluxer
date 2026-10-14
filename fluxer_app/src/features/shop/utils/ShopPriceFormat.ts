// SPDX-License-Identifier: AGPL-3.0-or-later

import {getCachedNumberFormat} from '@app/features/i18n/utils/IntlCache';
import {formatShopAzn, formatShopTry} from '@fluxer/schema/src/domains/shop/ShopPriceFormatting';
import type {ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';

export function formatTry(minor: number, locale: string): string {
	return formatShopTry(minor, locale);
}

// The amount only ("8,50"); the message around it names the currency.
export function formatAzn(minor: number, locale: string): string {
	return formatShopAzn(minor, locale);
}

// Older servers expose only the decimal rate; prefer the precise integer whenever it is supplied.
export function usdToAznRateMicro(
	price: {usd_to_azn_rate_micro?: number | null; usd_to_azn_rate?: string} | null | undefined,
): number | null {
	const rate = price?.usd_to_azn_rate_micro ?? Math.round(Number(price?.usd_to_azn_rate) * 1_000_000);
	return Number.isSafeInteger(rate) && rate > 0 ? rate : null;
}

// Keep the exact integer catalog rate: the legacy four-decimal string loses qepik precision.
// This is the same half-up formula as the server's computeShopPrice.
export function usdCentsToAznMinor(cents: number, rateMicro: number): number {
	return Math.floor((2 * cents * rateMicro + 1_000_000) / 2_000_000);
}

// The server already hides stale automatic rates. TL is informational and never prices an order.
export function aznMinorToTryMinor(minor: number, rateMicro: number | null | undefined): number | null {
	return rateMicro == null ? null : Math.floor((2 * minor * 1_000_000 + rateMicro) / (2 * rateMicro));
}

// TR "-%20", EN "-20%".
export function formatDiscount(percent: number, locale: string): string {
	return getCachedNumberFormat(locale, {style: 'percent'}).format(-percent / 100);
}

// One step of the server's computeShopPrice: `percent` off, rounded half up.
export function percentOff(cents: number, percent: number): number {
	return Math.floor((2 * cents * (100 - percent) + 100) / 200);
}

// Card prices are display only. A campaign shows until its end on the server clock; the server enforces the end.
export function campaignShown(price: ShopPriceResponse, now: number): boolean {
	return (
		price.campaign_percent !== null && (price.campaign_ends_at === null || Date.parse(price.campaign_ends_at) > now)
	);
}

// The price a card shows now: the campaign price while the campaign shows, the list price otherwise.
export function shownCents(price: ShopPriceResponse, now: number): number {
	return campaignShown(price, now) ? price.sale_usd_cents : price.base_usd_cents;
}
