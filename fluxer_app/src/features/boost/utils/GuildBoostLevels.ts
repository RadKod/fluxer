// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Guild} from '@app/features/guild/models/Guild';
import {GUILD_BOOST_LEVELS, type GuildBoostLevel} from '@fluxer/constants/src/GuildBoostConstants';
import {GuildFeatures, getMaxVoiceChannelBitrate} from '@fluxer/constants/src/GuildConstants';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import {resolveLimit} from '@fluxer/limits/src/LimitResolver';
import type {LimitConfigSnapshot} from '@fluxer/limits/src/LimitTypes';

// Shown for display only: the server decides a community's level and features from the same @fluxer/constants table.
export {GUILD_BOOST_LEVELS, type GuildBoostLevel};

export type GuildBoostPerk =
	| {type: 'bitrate'; kbps: number}
	| {type: 'emoji'; count: number}
	| {type: 'stickers'; count: number}
	| {type: 'vanity_url'};

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

function guildLimit(limits: LimitConfigSnapshot, features: Set<string>, key: LimitKey): number {
	return resolveLimit(limits, {traits: new Set(), guildFeatures: features}, key, {evaluationContext: 'guild'});
}

export function getGuildBoostLevelPerks(
	limits: LimitConfigSnapshot,
): Array<GuildBoostLevel & {perks: Array<GuildBoostPerk>}> {
	let features = new Set<string>();
	return GUILD_BOOST_LEVELS.map((level) => {
		const previous = features;
		features = new Set([...previous, ...level.features]);
		const perks: Array<GuildBoostPerk> = [];
		const kbps = getMaxVoiceChannelBitrate(features) / 1000;
		if (kbps > getMaxVoiceChannelBitrate(previous) / 1000) perks.push({type: 'bitrate', kbps});
		const emoji = guildLimit(limits, features, 'max_guild_emojis');
		if (emoji > guildLimit(limits, previous, 'max_guild_emojis')) perks.push({type: 'emoji', count: emoji});
		const stickers = guildLimit(limits, features, 'max_guild_stickers');
		if (stickers > guildLimit(limits, previous, 'max_guild_stickers')) perks.push({type: 'stickers', count: stickers});
		if (features.has(GuildFeatures.VANITY_URL) && !previous.has(GuildFeatures.VANITY_URL)) {
			perks.push({type: 'vanity_url'});
		}
		return {...level, perks};
	});
}
