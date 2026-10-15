// SPDX-License-Identifier: AGPL-3.0-or-later

import type {CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const COSMETIC_TYPE_LABELS: Record<CosmeticType, MessageDescriptor> = {
	avatar_decoration: msg({
		message: 'Avatar decoration',
		comment: 'A frame drawn around the user avatar. Profile decorations settings section title and search entry.',
	}),
	avatar_ultra: msg({
		message: 'Ultra decoration',
		comment: 'Big decoration, such as wings, behind the avatar. Profile decorations section title and search entry.',
	}),
	nameplate: msg({
		message: 'Nameplate',
		comment:
			'A background image behind the user name in member and direct message lists. Profile decorations settings section title and search entry.',
	}),
	profile_effect: msg({
		message: 'Profile effect',
		comment:
			'An animation played over the user profile card. Profile decorations settings section title and search entry.',
	}),
};

export const COSMETIC_TYPE_DESCRIPTIONS: Record<CosmeticType, MessageDescriptor> = {
	avatar_decoration: msg({
		message: 'A frame around your avatar.',
		comment: 'Profile decorations settings: what an avatar decoration is. Also the settings search entry description.',
	}),
	avatar_ultra: msg({
		message: 'Wings and other large decorations behind your avatar.',
		comment: 'Profile decorations settings: what ultra decorations are. Also the settings search entry description.',
	}),
	nameplate: msg({
		message: 'A background behind your name in member lists and direct messages.',
		comment: 'Profile decorations settings: what a nameplate is. Also the settings search entry description.',
	}),
	profile_effect: msg({
		message: 'An animation that plays over your profile card.',
		comment: 'Profile decorations settings: what a profile effect is. Also the settings search entry description.',
	}),
};

// sanalyer: the profile decorations tab and the shop list items one series at a time.
export const COSMETIC_SERIES_OTHER_DESCRIPTOR = msg({
	message: 'Other',
	comment: 'Group of cosmetic items that belong to no series, in the shop and the profile decorations settings.',
});
export const COSMETIC_MINE_DESCRIPTOR = msg({
	message: 'Mine',
	comment: 'Profile decorations settings: the group of items the user wears or owns, shown first.',
});
export const COSMETIC_SEARCH_PLACEHOLDER_DESCRIPTOR = msg({
	message: 'Search by name or series…',
	comment: 'Profile decorations settings: placeholder of the search box over the catalog.',
});
export const COSMETIC_SERIES_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# item} other {# items}}',
	comment: 'Profile decorations settings: how many items a series holds, next to its name.',
});
