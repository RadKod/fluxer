// SPDX-License-Identifier: AGPL-3.0-or-later

import {getBadgeService, getPioneerService} from '@app/api/middleware/ServiceSingletons';
import {
	registerUserAccountWriteHook,
	registerUserBannedHook,
	registerUserDeletionHook,
	registerUserHarvestHook,
} from '@app/api/user/lifecycle/UserLifecycleHooks';

// Account deletion unlinks the Öncü number, then drops the whole user_badges partition (a repeat run changes nothing);
// the data export lists the granted badges with their catalog text; the step to a verified account numbers it; a
// permanent or CSAM ban takes the Öncü badge back.
export function registerBadgeUserLifecycleHooks(): void {
	registerUserDeletionHook('badges', async ({userId}) => {
		await getPioneerService().forget(userId);
		await getBadgeService().deleteUserBadges(userId);
	});
	registerUserHarvestHook('badges', ({userId}) => getBadgeService().exportUserBadges(userId));
	registerUserAccountWriteHook('badges', (context) => getPioneerService().onAccountWritten(context));
	registerUserBannedHook('badges', ({userId}) => getPioneerService().revoke(userId));
}
