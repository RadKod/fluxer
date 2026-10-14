// SPDX-License-Identifier: AGPL-3.0-or-later

import Cosmetics, {type CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import type {User} from '@app/features/user/models/User';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';

export interface ShopItemActionInput {
	entry: ShopItemEntry;
	owned: boolean;
	equipped: boolean;
	isPremium: boolean; // may wear premium items (checkIsPremium on the client: User.isPremium()); a trial counts here
	itemSalesOpen: boolean;
	premiumSalesOpen: boolean;
	purchaseBlock: null | 'unclaimed' | 'unverified';
}

export type ShopItemAction =
	| {kind: 'buy'}
	| {kind: 'buy_disabled'; reason: 'unclaimed' | 'unverified'}
	| {kind: 'equip'}
	| {kind: 'equipped'}
	| {kind: 'get_premium'}
	| {kind: 'none'; label: 'not_on_sale' | null};

// The shop action table; the card and the detail dialog both ask here.
export function resolveShopItemAction({
	entry,
	owned,
	equipped,
	isPremium,
	itemSalesOpen,
	premiumSalesOpen,
	purchaseBlock,
}: ShopItemActionInput): ShopItemAction {
	const premiumItem = entry.item.availability === 'premium';
	if (owned || (premiumItem && isPremium)) return equipped ? {kind: 'equipped'} : {kind: 'equip'};
	if (premiumItem) return premiumSalesOpen ? {kind: 'get_premium'} : {kind: 'none', label: null};
	if (!itemSalesOpen || !entry.price) return {kind: 'none', label: 'not_on_sale'};
	return purchaseBlock ? {kind: 'buy_disabled', reason: purchaseBlock} : {kind: 'buy'};
}

export interface ShopBundleActionInput {
	entry: ShopBundleEntry;
	ownedCount: number; // items of the bundle the account has (ownsShopItem)
	itemSalesOpen: boolean;
	purchaseBlock: null | 'unclaimed' | 'unverified';
}

export type ShopBundleAction =
	| {kind: 'buy'}
	| {kind: 'buy_disabled'; reason: 'unclaimed' | 'unverified'}
	| {kind: 'none'; label: 'not_on_sale' | 'owned' | 'partly_owned'};

// A bundle sells like an item, on the item sales switch. The server refuses one with an item the account has
//, so neither is offered; it has nothing to equip, delivery wears it.
export function resolveShopBundleAction({
	entry,
	ownedCount,
	itemSalesOpen,
	purchaseBlock,
}: ShopBundleActionInput): ShopBundleAction {
	if (ownedCount > 0) {
		return {kind: 'none', label: ownedCount >= entry.bundle.items.length ? 'owned' : 'partly_owned'};
	}
	if (!itemSalesOpen) return {kind: 'none', label: 'not_on_sale'};
	return purchaseBlock ? {kind: 'buy_disabled', reason: purchaseBlock} : {kind: 'buy'};
}

// USER_UPDATE moves the worn slots at once; the owned list is read again only by Cosmetics.load. An owners-only item
// the account wears is owned, even when it was paid for after its dialog closed.
export function ownsShopItem(item: CosmeticItemResponse): boolean {
	if (Cosmetics.getItem(item.id)?.owned) return true;
	return item.availability === 'owned' && Cosmetics.equippedId(item.type as CosmeticType) === item.id;
}

export function purchaseBlockOf(user: User | null): 'unclaimed' | 'unverified' | null {
	if (!user?.isClaimed()) return 'unclaimed';
	return user.verified === true ? null : 'unverified';
}
