// SPDX-License-Identifier: AGPL-3.0-or-later

import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';

export interface GuildBoostLevel {
	readonly level: number;
	readonly boosts: number;
	readonly features: ReadonlyArray<string>;
	readonly limits: Readonly<Partial<Record<LimitKey, number>>>;
}

// Each level adds its features to all earlier levels. Limit rules use the same table as the client.
export const GUILD_BOOST_LEVELS: ReadonlyArray<GuildBoostLevel> = [
	{
		level: 1,
		boosts: 2,
		features: [
			GuildFeatures.BOOST_LEVEL_1,
			GuildFeatures.ANIMATED_ICON,
			GuildFeatures.AUDIO_BITRATE_128_KBPS,
			GuildFeatures.MORE_EMOJI,
		],
		limits: {
			max_guild_soundboard_sounds: 24,
			max_guild_video_height: 720,
			max_guild_video_fps: 60,
			max_guild_emojis: 1000,
			max_guild_stickers: 500,
			max_guild_channels: 500,
			max_guild_roles: 250,
			feature_role_icons: 1,
			feature_role_gradient: 0,
		},
	},
	{
		level: 2,
		boosts: 7,
		features: [GuildFeatures.BOOST_LEVEL_2, GuildFeatures.AUDIO_BITRATE_256_KBPS, GuildFeatures.MORE_STICKERS],
		limits: {
			max_guild_soundboard_sounds: 36,
			max_guild_video_height: 1080,
			max_guild_video_fps: 60,
			max_guild_emojis: 1250,
			max_guild_stickers: 1000,
			max_guild_channels: 600,
			max_guild_roles: 300,
			feature_role_icons: 1,
			feature_role_gradient: 1,
			max_attachment_file_size: 50_000_000,
		},
	},
	{
		level: 3,
		boosts: 14,
		features: [
			GuildFeatures.BOOST_LEVEL_3,
			GuildFeatures.ANIMATED_BANNER,
			GuildFeatures.AUDIO_BITRATE_384_KBPS,
			GuildFeatures.VANITY_URL,
		],
		limits: {
			max_guild_soundboard_sounds: 48,
			max_guild_video_height: 1080,
			max_guild_video_fps: 60,
			max_guild_emojis: 1500,
			max_guild_stickers: 1250,
			max_guild_channels: 750,
			max_guild_roles: 350,
			feature_role_icons: 1,
			feature_role_gradient: 1,
			max_attachment_file_size: 100_000_000,
		},
	},
];
