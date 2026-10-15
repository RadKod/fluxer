// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Guild} from '@app/features/guild/models/Guild';
import {GUILD_BOOST_LEVELS, type GuildBoostLevel} from '@fluxer/constants/src/GuildBoostConstants';
import {GuildFeatures, getMaxVoiceChannelBitrate} from '@fluxer/constants/src/GuildConstants';
import {resolveLimits} from '@fluxer/limits/src/LimitResolver';
import type {LimitConfigSnapshot} from '@fluxer/limits/src/LimitTypes';

// Shown for display only: the server decides a community's level and features from the same @fluxer/constants table.
export {GUILD_BOOST_LEVELS, type GuildBoostLevel};

export type GuildBoostPerk =
	| {type: 'bitrate'; kbps: number}
	| {type: 'emoji' | 'stickers' | 'soundboard'; count: number}
	| {
			type: 'animated_icon' | 'animated_banner' | 'static_banner' | 'vanity_url' | 'role_icons' | 'role_gradient';
			available: boolean;
	  }
	| {type: 'video'; height: number; fps: number}
	| {type: 'file'; bytes: number | null}
	| {type: 'capacity'; channels: number; roles: number};

export interface GuildBoostStatus {
	level: number;
	count: number;
	next: GuildBoostLevel | null;
}

export function isGuildBoostAvailable(guild: Pick<Guild, 'unavailable'> | undefined): boolean {
	return guild != null && !guild.unavailable;
}

export function getGuildBoostStatus(guild: Pick<Guild, 'premiumTier' | 'premiumSubscriptionCount'>): GuildBoostStatus {
	const level = guild.premiumTier ?? 0;
	return {
		level,
		count: guild.premiumSubscriptionCount ?? 0,
		next: GUILD_BOOST_LEVELS.find((candidate) => candidate.level === level + 1) ?? null,
	};
}

export function getGuildBoostLevelPerks(
	limits: LimitConfigSnapshot,
	guild?: Pick<Guild, 'premiumTier' | 'features'>,
): Array<GuildBoostLevel & {perks: Array<GuildBoostPerk>}> {
	const base: GuildBoostLevel = {
		level: 0,
		boosts: 0,
		features: [GuildFeatures.BANNER, GuildFeatures.INVITE_SPLASH],
		limits: {},
	};
	const personal = resolveLimits(limits, {traits: new Set(), guildFeatures: new Set()}).limits.max_attachment_file_size;
	let projected = new Set<string>();
	return [base, ...GUILD_BOOST_LEVELS].map((level) => {
		projected = new Set([...projected, ...level.features]);
		// Current features also include independent grants and retained perks during the grace period.
		const features = guild && level.level === (guild.premiumTier ?? 0) ? new Set(guild.features) : projected;
		const resolved = resolveLimits(
			limits,
			{traits: new Set(), guildFeatures: features},
			{evaluationContext: 'guild'},
		).limits;
		const perks: Array<GuildBoostPerk> = [
			{type: 'animated_icon', available: features.has(GuildFeatures.ANIMATED_ICON)},
			{type: 'animated_banner', available: features.has(GuildFeatures.ANIMATED_BANNER)},
			{
				type: 'static_banner',
				available: features.has(GuildFeatures.BANNER) && features.has(GuildFeatures.INVITE_SPLASH),
			},
			{type: 'vanity_url', available: features.has(GuildFeatures.VANITY_URL)},
			{type: 'video', height: resolved.max_guild_video_height, fps: resolved.max_guild_video_fps},
			{type: 'soundboard', count: resolved.max_guild_soundboard_sounds},
			{type: 'bitrate', kbps: getMaxVoiceChannelBitrate(features) / 1000},
			{
				type: 'emoji',
				count: features.has(GuildFeatures.UNLIMITED_EMOJI) ? Number.POSITIVE_INFINITY : resolved.max_guild_emojis,
			},
			{
				type: 'stickers',
				count: features.has(GuildFeatures.UNLIMITED_STICKERS) ? Number.POSITIVE_INFINITY : resolved.max_guild_stickers,
			},
			{type: 'role_icons', available: resolved.feature_role_icons > 0},
			{type: 'role_gradient', available: resolved.feature_role_gradient > 0},
			{type: 'file', bytes: resolved.max_attachment_file_size > personal ? resolved.max_attachment_file_size : null},
			{type: 'capacity', channels: resolved.max_guild_channels, roles: resolved.max_guild_roles},
		];
		return {...level, perks};
	});
}
