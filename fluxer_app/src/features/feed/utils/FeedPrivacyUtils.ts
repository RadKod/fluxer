// SPDX-License-Identifier: AGPL-3.0-or-later

import {isFeedDiscoverEnabled} from '@app/features/feed/utils/FeedUtils';
import UserSettings from '@app/features/user/state/UserSettings';
import {getEffectiveProfilePrivacy} from '@app/features/user/utils/ProfilePrivacyUtils';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';

// Whether your posts reach strangers and Discover, so the note beside the feed says so. Micup: only a
// public profile's posts do; the server sets each post's public bit from the profile visibility , so the
// composer sends none. Not with Discover off, nor before the settings load.
export function canFeedPostsBePublic(): boolean {
	return (
		isFeedDiscoverEnabled() &&
		UserSettings.isHydrated() &&
		getEffectiveProfilePrivacy() === ProfilePrivacyLevels.EVERYONE
	);
}
