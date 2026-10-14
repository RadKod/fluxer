// SPDX-License-Identifier: AGPL-3.0-or-later

import {isProfileHidden} from '@app/api/user/ProfileVisibility';
import {registerProfileExtension} from '@app/api/user/profile/ProfileExtensionProviders';
import {mapCosmeticAssetData} from '@app/api/user/UserMappers';

// The profile effect is shown like the banner, restricted profile or not, read off the profile's own user row. Sent as
// null when none is worn, so a client that cached an earlier profile drops the effect.
export function registerCosmeticProfileExtension(): void {
	registerProfileExtension('profile_effect', async ({user}) => ({
		profile_effect_data: isProfileHidden(user)
			? null
			: mapCosmeticAssetData(user.profileEffectId, user.profileEffectAsset),
	}));
}
