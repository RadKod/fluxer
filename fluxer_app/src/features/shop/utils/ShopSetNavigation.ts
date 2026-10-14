// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {shopSetPath} from '@app/features/shop/utils/ShopSets';

// The set the shop itself opened: the entry before its page is the shop, so leaving it is a step back.
let openedFromShop: string | null = null;

export function openShopSet(bundleId: string): void {
	openedFromShop = bundleId;
	RouterUtils.transitionTo(shopSetPath(bundleId));
}

// Escape on a set's page: back to the shop without a new history entry. A set opened from a link has no shop entry
// before it, so its page is replaced by the shop's.
export function leaveShopSet(bundleId: string): void {
	const back = openedFromShop === bundleId;
	openedFromShop = null;
	if (back) RouterUtils.getHistory()?.back();
	else RouterUtils.replaceWith(Routes.SHOP);
}
