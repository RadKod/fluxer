// SPDX-License-Identifier: AGPL-3.0-or-later

import {createDefaultLimitConfig} from '@app/api/constants/LimitConfig';
import {
	GUILD_BOOST_FEATURES,
	GUILD_BOOST_LEVELS,
	guildBoostFeatures,
	guildBoostTier,
} from '@app/api/guild/boost/GuildBoostLevels';
import {GUILD_BOOST_LEVELS as SHARED_GUILD_BOOST_LEVELS} from '@fluxer/constants/src/GuildBoostConstants';
import {GuildFeatures, getMaxVoiceChannelBitrate} from '@fluxer/constants/src/GuildConstants';
import {MAX_GUILD_EMOJIS, MAX_GUILD_STICKERS} from '@fluxer/constants/src/LimitConstants';
import {resolveLimit} from '@fluxer/limits/src/LimitResolver';
import {describe, expect, it} from 'vitest';

// Resolved against every stock configuration (hosted, self-hosted mirror, self-hosted everyone); they must agree.
function guildLimit(features: Iterable<string>, key: 'max_guild_emojis' | 'max_guild_stickers'): number {
	const ctx = {traits: new Set<string>(), guildFeatures: new Set(features)};
	const values = [
		createDefaultLimitConfig({selfHosted: false}),
		createDefaultLimitConfig({selfHosted: true, premiumMode: 'mirror'}),
		createDefaultLimitConfig({selfHosted: true, premiumMode: 'everyone'}),
	].map((config) => resolveLimit(config, ctx, key, {evaluationContext: 'guild'}));
	expect(new Set(values).size).toBe(1);
	return values[0]!;
}

describe('guild boost levels', () => {
	it('decides levels from the table the client also shows (@fluxer/constants)', () => {
		expect(GUILD_BOOST_LEVELS).toBe(SHARED_GUILD_BOOST_LEVELS);
	});

	it('maps a boost count to its level at the 2, 7 and 14 thresholds', () => {
		expect([0, 1, 2, 6, 7, 13, 14, 200].map(guildBoostTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
	});

	it('grants the features of every level up to the given one', () => {
		expect(guildBoostFeatures(0)).toEqual(new Set());
		expect(guildBoostFeatures(2)).toEqual(
			new Set([
				GuildFeatures.BOOST_LEVEL_1,
				GuildFeatures.BOOST_LEVEL_2,
				GuildFeatures.ANIMATED_ICON,
				GuildFeatures.AUDIO_BITRATE_128_KBPS,
				GuildFeatures.MORE_EMOJI,
				GuildFeatures.AUDIO_BITRATE_256_KBPS,
				GuildFeatures.MORE_STICKERS,
			]),
		);
		expect(guildBoostFeatures(3)).toEqual(GUILD_BOOST_FEATURES);
	});

	it('only ever grants the level feature allowlist', () => {
		expect([...GUILD_BOOST_FEATURES].sort()).toEqual([
			'ANIMATED_BANNER',
			'ANIMATED_ICON',
			'AUDIO_BITRATE_128_KBPS',
			'AUDIO_BITRATE_256_KBPS',
			'AUDIO_BITRATE_384_KBPS',
			'BOOST_LEVEL_1',
			'BOOST_LEVEL_2',
			'BOOST_LEVEL_3',
			'MORE_EMOJI',
			'MORE_STICKERS',
			'VANITY_URL',
		]);
	});

	it('raises the voice bitrate ceiling at every level', () => {
		expect([0, 1, 2, 3].map((tier) => getMaxVoiceChannelBitrate(guildBoostFeatures(tier)))).toEqual([
			96000, 128000, 256000, 384000,
		]);
	});

	it('raises the emoji limit from level 1 and the sticker limit from level 2 through the stock limit rules', () => {
		expect(guildLimit(guildBoostFeatures(0), 'max_guild_emojis')).toBe(MAX_GUILD_EMOJIS);
		expect(guildLimit(guildBoostFeatures(1), 'max_guild_emojis')).toBeGreaterThan(MAX_GUILD_EMOJIS);
		expect(guildLimit(guildBoostFeatures(1), 'max_guild_stickers')).toBe(MAX_GUILD_STICKERS);
		expect(guildLimit(guildBoostFeatures(2), 'max_guild_stickers')).toBeGreaterThan(MAX_GUILD_STICKERS);
	});
});
