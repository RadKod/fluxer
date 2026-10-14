// SPDX-License-Identifier: AGPL-3.0-or-later

import {getBadgeService} from '@app/api/middleware/ServiceSingletons';
import {registerProfileExtension} from '@app/api/user/profile/ProfileExtensionProviders';

// A restricted profile strips badges with the bio and connections (UserProfileFullResponse.profile_limited), so the
// field is left out entirely there, and the badge store is not even read.
export function registerBadgeProfileExtension(): void {
	registerProfileExtension('badges', async ({userId, restrictProfile, cachedBadges}) =>
		restrictProfile ? {} : {badges: cachedBadges ?? (await getBadgeService().getProfileBadges(userId))},
	);
}
