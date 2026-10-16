// SPDX-License-Identifier: AGPL-3.0-or-later

import {GUILD_BOOST_LEVELS} from '@fluxer/constants/src/GuildBoostConstants';
import * as SoundboardConstants from '@fluxer/constants/src/SoundboardConstants';
import {describe, expect, it} from 'vitest';

describe('GUILD_BOOST_LEVELS', () => {
	it('opens level 1, 2 and 3 at 2, 7 and 14 boosts with their features', () => {
		expect(GUILD_BOOST_LEVELS).toMatchObject([
			{level: 1, boosts: 2, features: ['BOOST_LEVEL_1', 'ANIMATED_ICON', 'AUDIO_BITRATE_128_KBPS', 'MORE_EMOJI']},
			{level: 2, boosts: 7, features: ['BOOST_LEVEL_2', 'AUDIO_BITRATE_256_KBPS', 'MORE_STICKERS']},
			{level: 3, boosts: 14, features: ['BOOST_LEVEL_3', 'ANIMATED_BANNER', 'AUDIO_BITRATE_384_KBPS', 'VANITY_URL']},
		]);
	});

	it('shares exact sound upload byte and millisecond bounds', () => {
		expect(SoundboardConstants).toMatchObject({
			SOUNDBOARD_MAX_SIZE_BYTES: 1_000_000,
			SOUNDBOARD_MAX_DURATION_MS: 10_000,
		});
	});
});
