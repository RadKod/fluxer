// SPDX-License-Identifier: AGPL-3.0-or-later

import UserSettings from '@app/features/user/state/UserSettings';
import Users from '@app/features/user/state/Users';
import {type ProfilePrivacyLevel, ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';

// Micup: the level the server applies now (resolveProfileAudience). The legacy 1 reads as shared communities,
// and so does a stored Everyone until the account may have a public profile (16 and a date of birth): the settings, the
// feed note and the connection note show this, never the stored value.
export function getEffectiveProfilePrivacy(): ProfilePrivacyLevel {
	const stored = UserSettings.getProfilePrivacy();
	if (stored === ProfilePrivacyLevels.SMALL_GUILDS_ONLY) return ProfilePrivacyLevels.ALL_GUILDS;
	if (stored === ProfilePrivacyLevels.EVERYONE && Users.currentUser?.publicProfileAllowed !== true) {
		return ProfilePrivacyLevels.ALL_GUILDS;
	}
	return stored;
}
