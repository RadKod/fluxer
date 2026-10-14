// SPDX-License-Identifier: AGPL-3.0-or-later

import {calculateAge} from '@app/api/utils/AgeUtils';
import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';

export type ProfileAudience = 'everyone' | 'guilds' | 'close' | 'only_me';

// a public profile needs a date of birth and 16 years. The suggestion pool keeps its own 18.
export const PUBLIC_PROFILE_MIN_AGE = 16;

export function canHavePublicProfile(dateOfBirth: string | null | undefined): boolean {
	return dateOfBirth != null && calculateAge(dateOfBirth) >= PUBLIC_PROFILE_MIN_AGE;
}

/**
 * What a stored profile_privacy means now; read, never rewritten in bulk. 0, the legacy 1 and an empty column
 * are the shared communities option, 2 friends and mutual follows; 100 is public only for 16 or older; 101 and any value
 * this release does not know show the content to the owner only.
 */
export function resolveProfileAudience(
	level: number | null | undefined,
	dateOfBirth: string | null | undefined,
): ProfileAudience {
	switch (level ?? ProfilePrivacyLevels.ALL_GUILDS) {
		case ProfilePrivacyLevels.ALL_GUILDS:
		case ProfilePrivacyLevels.SMALL_GUILDS_ONLY:
			return 'guilds';
		case ProfilePrivacyLevels.FRIENDS_ONLY:
			return 'close';
		case ProfilePrivacyLevels.EVERYONE:
			return canHavePublicProfile(dateOfBirth) ? 'everyone' : 'guilds';
		default:
			return 'only_me';
	}
}
