// SPDX-License-Identifier: AGPL-3.0-or-later

import {getCosmeticService} from '@app/api/middleware/ServiceSingletons';
import {registerUserDeletionHook, registerUserHarvestHook} from '@app/api/user/lifecycle/UserLifecycleHooks';

// anonymizeForDeletion does not know the cosmetic columns, so account deletion drops the owned items and clears the
// worn ones here; the data export lists both.
export function registerCosmeticUserLifecycleHooks(): void {
	registerUserDeletionHook('cosmetics', ({userId}) => getCosmeticService().deleteUserCosmetics(userId));
	registerUserHarvestHook('cosmetics', ({userId}) => getCosmeticService().harvestUserCosmetics(userId));
}
