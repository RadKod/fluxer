// SPDX-License-Identifier: AGPL-3.0-or-later

import {getGuildBoostService} from '@app/api/middleware/ServiceSingletons';
import {registerUserDeletionHook, registerUserHarvestHook} from '@app/api/user/lifecycle/UserLifecycleHooks';

// Account deletion takes every boost off its guild (freeing the slot and counting the guild down) and drops the slot
// rows; running it again finds nothing left to do. The data export lists the slots and what they boost.
export function registerGuildBoostUserLifecycleHooks(): void {
	registerUserDeletionHook('boosts', async ({userId}) => getGuildBoostService().deleteUserBoosts(userId));
	registerUserHarvestHook('boosts', async ({userId}) => getGuildBoostService().harvestUserBoosts(userId));
}
