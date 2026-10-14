// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildBoostPerk} from '@app/features/boost/utils/GuildBoostLevels';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const LEVEL_DESCRIPTOR = msg({message: 'Level {level}', comment: 'Community boost level, from 1 to 3.'});
export const BOOST_COUNT_DESCRIPTOR = msg({
	message: '{count, plural, one {# boost} other {# boosts}}',
	comment: 'Community boost count or level threshold.',
});
export const TOP_LEVEL_DESCRIPTOR = msg({
	message: 'Top level reached',
	comment: 'Community has reached the highest boost level.',
});
export const GOAL_DESCRIPTOR = msg({
	message: 'Goal: Level {level}',
	comment: 'Next community boost level in the header goal row.',
});
export const LEVEL_TOTAL_DESCRIPTOR = msg({
	message: 'Level {level} requires {count, plural, one {# boost} other {# boosts}} in total',
	comment: 'Fixed total boost threshold for the next level, never the remaining boost count.',
});
export const LEVEL_PROGRESS_DESCRIPTOR = msg({
	message: 'Community boost level {level} of 3',
	comment: 'Accessible label for the three-segment community boost level bar.',
});
export const PROGRESS_DESCRIPTOR = msg({
	message: '{count} / {goal} boosts',
	comment: 'Accessible label for community boost progress. Count is current boosts and goal is next level threshold.',
});
export const BOOST_DESCRIPTOR = msg({
	message: 'Boost now',
	comment: 'Short visual action hint in the community boost goal row.',
});
export const PERKS_DESCRIPTOR = msg({
	message: 'Community boost perks',
	comment: 'Title of the community boost perks dialog.',
});
export const UNLOCKED_DESCRIPTOR = msg({
	message: 'Unlocked',
	comment: 'Boost level perks already unlocked for this community.',
});
export const NEXT_LEVEL_DESCRIPTOR = msg({
	message: 'Next level',
	comment: 'Marks the next community boost level card.',
});

const BITRATE_DESCRIPTOR = msg({
	message: 'Voice quality up to {kbps} kbps',
	comment: 'Boost perk: highest voice channel bitrate, in kbps.',
});
const EMOJI_DESCRIPTOR = msg({
	message: '{count, plural, one {Up to # emoji} other {Up to # emoji}}',
	comment: 'Boost perk: custom emoji capacity from this instance limits.',
});
const STICKERS_DESCRIPTOR = msg({
	message: '{count, plural, one {Up to # sticker} other {Up to # stickers}}',
	comment: 'Boost perk: custom sticker capacity from this instance limits.',
});
const VANITY_DESCRIPTOR = msg({message: 'Vanity URL', comment: 'Boost perk: a custom community invite link.'});

export function guildBoostPerkLabel(i18n: I18n, perk: GuildBoostPerk): string {
	switch (perk.type) {
		case 'bitrate':
			return i18n._(BITRATE_DESCRIPTOR, {kbps: perk.kbps});
		case 'emoji':
			return i18n._(EMOJI_DESCRIPTOR, {count: perk.count});
		case 'stickers':
			return i18n._(STICKERS_DESCRIPTOR, {count: perk.count});
		case 'vanity_url':
			return i18n._(VANITY_DESCRIPTOR);
	}
}
