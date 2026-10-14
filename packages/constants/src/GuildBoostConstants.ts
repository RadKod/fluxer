// SPDX-License-Identifier: AGPL-3.0-or-later

import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';

export interface GuildBoostLevel {
	readonly level: number;
	readonly boosts: number;
	readonly features: ReadonlyArray<string>;
}

// Micup community boost levels: the API decides a community's level and features from this table and the client shows
// it. Emoji and sticker slots come from the stock limit rules that name MORE_EMOJI and MORE_STICKERS.
export const GUILD_BOOST_LEVELS: ReadonlyArray<GuildBoostLevel> = [
	{level: 1, boosts: 2, features: [GuildFeatures.AUDIO_BITRATE_128_KBPS, GuildFeatures.MORE_EMOJI]},
	{level: 2, boosts: 7, features: [GuildFeatures.AUDIO_BITRATE_256_KBPS, GuildFeatures.MORE_STICKERS]},
	{level: 3, boosts: 14, features: [GuildFeatures.AUDIO_BITRATE_384_KBPS, GuildFeatures.VANITY_URL]},
];
