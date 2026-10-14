// SPDX-License-Identifier: AGPL-3.0-or-later

import {GUILD_BOOST_LEVELS} from '@fluxer/constants/src/GuildBoostConstants';
import {describe, expect, it} from 'vitest';

describe('GUILD_BOOST_LEVELS', () => {
	it('opens level 1, 2 and 3 at 2, 7 and 14 boosts with their features', () => {
		expect(GUILD_BOOST_LEVELS).toEqual([
			{level: 1, boosts: 2, features: ['AUDIO_BITRATE_128_KBPS', 'MORE_EMOJI']},
			{level: 2, boosts: 7, features: ['AUDIO_BITRATE_256_KBPS', 'MORE_STICKERS']},
			{level: 3, boosts: 14, features: ['AUDIO_BITRATE_384_KBPS', 'VANITY_URL']},
		]);
	});
});
