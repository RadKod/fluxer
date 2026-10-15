// SPDX-License-Identifier: AGPL-3.0-or-later

import {COSMETIC_TYPE_DESCRIPTIONS, COSMETIC_TYPE_LABELS} from '@app/features/cosmetics/utils/CosmeticLabels';
import type {SearchableSettingDescriptor} from '@app/features/user/components/settings_utils/search_index/SearchIndexTypes';
import {msg} from '@lingui/core/macro';

const FRAME_DESCRIPTOR = msg({
	message: 'Frame',
	comment: 'Settings search synonym. Used to match this term when the user types it in the settings search bar.',
});
const DECORATION_DESCRIPTOR = msg({
	message: 'Decoration',
	comment: 'Settings search synonym. Used to match this term when the user types it in the settings search bar.',
});
const NAME_BACKGROUND_DESCRIPTOR = msg({
	message: 'Name background',
	comment: 'Settings search synonym. Used to match this term when the user types it in the settings search bar.',
});
const ANIMATION_DESCRIPTOR = msg({
	message: 'Animation',
	comment: 'Settings search synonym. Used to match this term when the user types it in the settings search bar.',
});

export const profileCosmeticsIndex: Array<SearchableSettingDescriptor> = [
	{
		id: 'profile-cosmetics-avatar-decoration',
		tabType: 'profile_cosmetics',
		label: COSMETIC_TYPE_LABELS.avatar_decoration,
		keywords: [COSMETIC_TYPE_LABELS.avatar_decoration, FRAME_DESCRIPTOR, DECORATION_DESCRIPTOR],
		description: COSMETIC_TYPE_DESCRIPTIONS.avatar_decoration,
	},
	// sanalyer: ultra decorations are not offered (VISIBLE_COSMETIC_TYPES), so the search does not list them.
	{
		id: 'profile-cosmetics-nameplate',
		tabType: 'profile_cosmetics',
		label: COSMETIC_TYPE_LABELS.nameplate,
		keywords: [COSMETIC_TYPE_LABELS.nameplate, NAME_BACKGROUND_DESCRIPTOR, DECORATION_DESCRIPTOR],
		description: COSMETIC_TYPE_DESCRIPTIONS.nameplate,
	},
	{
		id: 'profile-cosmetics-profile-effect',
		tabType: 'profile_cosmetics',
		label: COSMETIC_TYPE_LABELS.profile_effect,
		keywords: [COSMETIC_TYPE_LABELS.profile_effect, ANIMATION_DESCRIPTOR, DECORATION_DESCRIPTOR],
		description: COSMETIC_TYPE_DESCRIPTIONS.profile_effect,
	},
];
