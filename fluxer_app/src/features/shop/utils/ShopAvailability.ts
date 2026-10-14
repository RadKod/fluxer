// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';

// Micup: the shop sells through Payriff on a mirror instance (self-hosted with gift codes). Its sale switches come with
// the catalog and never hide the page, so owned items can still be equipped and codes redeemed.
export function isShopPageAvailable(): boolean {
	return RuntimeConfig.isSelfHosted() && RuntimeConfig.giftCodesEnabled;
}
