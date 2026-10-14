// SPDX-License-Identifier: AGPL-3.0-or-later

import {GUILD_BOOST_LEVELS} from '@fluxer/constants/src/GuildBoostConstants';

// The level table lives in @fluxer/constants, where the client reads it too.
export {GUILD_BOOST_LEVELS};

// The fixed allowlist: boosting adds or removes these features and never touches any other one.
export const GUILD_BOOST_FEATURES: ReadonlySet<string> = new Set(GUILD_BOOST_LEVELS.flatMap((level) => level.features));

export function guildBoostTier(boostCount: number): number {
	return GUILD_BOOST_LEVELS.filter((level) => boostCount >= level.boosts).length;
}

export function guildBoostFeatures(tier: number): Set<string> {
	return new Set(GUILD_BOOST_LEVELS.filter((level) => level.level <= tier).flatMap((level) => level.features));
}
