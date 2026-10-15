// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';

// Micup: the shop sells through Payriff on a mirror instance (self-hosted with gift codes). Its sale switches come with
// the catalog and never hide the page, so owned items can still be equipped and codes redeemed.
// sanalyer: on a direct page load the route guard runs before the instance snapshot is active. Reading
// RuntimeConfig.features then throws inside a MobX computed; with disableErrorBoundaries (index.tsx) the computed
// stays marked as computing and every later read crashes the app with "cycle detected". Without a snapshot the page
// is let through; it decides again once the runtime is active.
export function isShopPageAvailable(): boolean {
	if (RuntimeConfig.getSnapshotOrNull() === null) return true;
	return RuntimeConfig.isSelfHosted() && RuntimeConfig.giftCodesEnabled;
}
