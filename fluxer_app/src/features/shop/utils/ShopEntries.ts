// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import type {ShopBundleResponse, ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';

// Lifetime premium with a numbered badge; sold on the premium page, never in the shop tab.
export const VISIONARY_SKU = 'visionary';

export type ShopItemEntry = {kind: 'item'; sku: string; item: CosmeticItemResponse; price: ShopPriceResponse | null};
export type ShopPackageEntry = {kind: 'package'; sku: string; months: 1 | 3 | 12; price: ShopPriceResponse};
// A bundle carries its items: a bundle-only item has no price, so the items list does not have it.
export type ShopBundleEntry = {kind: 'bundle'; sku: string; bundle: ShopBundleResponse; price: ShopPriceResponse};
export type ShopEntry = ShopItemEntry | ShopPackageEntry | ShopBundleEntry;

export function itemSku(itemId: string): string {
	return `cosmetic:${itemId}`;
}

export function packageSku(months: 1 | 3 | 12): string {
	return `premium:${months}`;
}
