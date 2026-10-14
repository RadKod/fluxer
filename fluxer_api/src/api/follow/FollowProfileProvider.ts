// SPDX-License-Identifier: AGPL-3.0-or-later

import {getFollowService} from '@app/api/middleware/ServiceSingletons';
import {registerProfileExtension} from '@app/api/user/profile/ProfileExtensionProviders';

// follower_count, following_count and is_following (left out on your own profile). A restricted profile gets none of
// them, the same rule that hides the lists.
export function registerFollowProfileExtension(): void {
	registerProfileExtension('follow_counts', async ({userId, viewerId, restrictProfile}) =>
		restrictProfile ? {} : getFollowService().getProfileFields(userId, viewerId),
	);
}
