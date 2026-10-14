// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';

// sanalyer: the one switch that lets the shop take money. Prices are Turkish lira and no TRY payment provider is
// wired yet, so on our instance every sale stays closed and items and premium time are given through gift codes and
// admin grants. Micup's Payriff integration is AZN-only and stays dormant behind FLUXER_PAYRIFF_ENABLED, which
// sanalyer never sets. A Turkish provider plugs in here (this switch) and as the client ShopOrderService opens and
// verifies orders with (ShopOrderServiceDeps.payriffClient today).
export function isShopPaymentProviderConfigured(): boolean {
	return Config.payriff.enabled;
}
