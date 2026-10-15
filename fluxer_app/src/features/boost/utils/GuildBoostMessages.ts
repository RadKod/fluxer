// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildBoostPerk} from '@app/features/boost/utils/GuildBoostLevels';
import type {I18n} from '@lingui/core';
import {msg} from '@lingui/core/macro';

export const LEVEL_DESCRIPTOR = msg({message: 'Level {level}', comment: 'Community boost level, from 0 to 3.'});
export const BASE_PERKS_DESCRIPTOR = msg({
	message: 'Base perks',
	comment: 'Community perks included without boosts at level 0.',
});
export const BASE_INCLUDED_DESCRIPTOR = msg({
	message: 'Included without boosts',
	comment: 'Level 0 card has no boost threshold or purchase requirement.',
});
export const REMAINING_BOOSTS_DESCRIPTOR = msg({
	message: '{count, plural, one {# more boost to Level {level}} other {# more boosts to Level {level}}}',
	comment: 'Remaining boosts, calculated by subtracting current count from the next total threshold.',
});
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
const ICON_DESCRIPTOR = msg({message: 'Animated community icon', comment: 'Boost perk: animated community logo.'});
const BANNER_DESCRIPTOR = msg({message: 'Animated banner', comment: 'Boost perk: animated community banner.'});
const STATIC_BANNER_DESCRIPTOR = msg({
	message: 'Static banner and invite background',
	comment: 'Base community perk: static banner and invite splash.',
});
const ROLE_ICON_DESCRIPTOR = msg({
	message: 'Role icons: Unicode or community emoji',
	comment: 'Boost perk: role icons use Unicode or an emoji from this community.',
});
const ROLE_GRADIENT_DESCRIPTOR = msg({
	message: 'Static two-color role gradients',
	comment: 'Boost perk: static role gradients with two colors.',
});
const AVAILABLE_DESCRIPTOR = msg({
	message: '{perk}: Available',
	comment: 'Availability of a community perk on a level card.',
});
const NOT_INCLUDED_DESCRIPTOR = msg({
	message: '{perk}: Not included',
	comment: 'Community perk that is not included at the displayed level.',
});
const VIDEO_DESCRIPTOR = msg({
	message: 'Streaming and camera up to {height}p / {fps} fps',
	comment: 'Community voice-channel video profile; personal video allowances remain separate.',
});
const SOUNDS_DESCRIPTOR = msg({
	message: '{count, plural, one {# soundboard slot} other {# soundboard slots}}',
	comment: 'Total community soundboard slots from the effective instance limits.',
});
const NO_SOUNDS_DESCRIPTOR = msg({
	message: 'No soundboard slots',
	comment: 'Soundboard capacity is disabled in the effective instance limits.',
});
const NO_EMOJI_DESCRIPTOR = msg({
	message: 'No custom emoji slots',
	comment: 'Custom emoji capacity is disabled in the effective instance limits.',
});
const NO_STICKERS_DESCRIPTOR = msg({
	message: 'No custom sticker slots',
	comment: 'Custom sticker capacity is disabled in the effective instance limits.',
});
const UNLIMITED_EMOJI_DESCRIPTOR = msg({
	message: 'Unlimited custom emoji',
	comment: 'Independent community unlimited-emoji feature.',
});
const UNLIMITED_STICKERS_DESCRIPTOR = msg({
	message: 'Unlimited custom stickers',
	comment: 'Independent community unlimited-sticker feature.',
});
const PERSONAL_FILE_DESCRIPTOR = msg({
	message: 'Server file uploads: your personal limit',
	comment: 'Community file uploads have no extra allowance above the personal allowance at this level.',
});
const FILE_DESCRIPTOR = msg({
	message: 'Server file uploads: your personal limit, or {megabytes} MB if higher',
	comment: 'The higher of personal and community file allowance; MB is decimal, one million bytes.',
});
const CAPACITY_DESCRIPTOR = msg({
	message: '{channels} channels / {roles} roles in total',
	comment: 'Combined total community channel and role capacities from the effective limits.',
});

export function guildBoostPerkLabel(i18n: I18n, perk: GuildBoostPerk): string {
	switch (perk.type) {
		case 'bitrate':
			return i18n._(BITRATE_DESCRIPTOR, {kbps: perk.kbps});
		case 'emoji':
			return perk.count === Number.POSITIVE_INFINITY
				? i18n._(UNLIMITED_EMOJI_DESCRIPTOR)
				: perk.count === 0
					? i18n._(NO_EMOJI_DESCRIPTOR)
					: i18n._(EMOJI_DESCRIPTOR, {count: perk.count});
		case 'stickers':
			return perk.count === Number.POSITIVE_INFINITY
				? i18n._(UNLIMITED_STICKERS_DESCRIPTOR)
				: perk.count === 0
					? i18n._(NO_STICKERS_DESCRIPTOR)
					: i18n._(STICKERS_DESCRIPTOR, {count: perk.count});
		case 'soundboard':
			return perk.count === 0 ? i18n._(NO_SOUNDS_DESCRIPTOR) : i18n._(SOUNDS_DESCRIPTOR, {count: perk.count});
		case 'video':
			return i18n._(VIDEO_DESCRIPTOR, {height: perk.height, fps: perk.fps});
		case 'file':
			return perk.bytes == null
				? i18n._(PERSONAL_FILE_DESCRIPTOR)
				: i18n._(FILE_DESCRIPTOR, {megabytes: i18n.number(perk.bytes / 1_000_000, {maximumFractionDigits: 2})});
		case 'capacity':
			return i18n._(CAPACITY_DESCRIPTOR, {channels: i18n.number(perk.channels), roles: i18n.number(perk.roles)});
		case 'animated_icon':
		case 'animated_banner':
		case 'static_banner':
		case 'vanity_url':
		case 'role_icons':
		case 'role_gradient': {
			const descriptor = {
				animated_icon: ICON_DESCRIPTOR,
				animated_banner: BANNER_DESCRIPTOR,
				static_banner: STATIC_BANNER_DESCRIPTOR,
				vanity_url: VANITY_DESCRIPTOR,
				role_icons: ROLE_ICON_DESCRIPTOR,
				role_gradient: ROLE_GRADIENT_DESCRIPTOR,
			}[perk.type];
			return i18n._(perk.available ? AVAILABLE_DESCRIPTOR : NOT_INCLUDED_DESCRIPTOR, {perk: i18n._(descriptor)});
		}
	}
}
