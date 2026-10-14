// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	GUILD_BOOST_LEVELS,
	getGuildBoostLevelPerks,
	getGuildBoostStatus,
} from '@app/features/boost/utils/GuildBoostLevels';
import {GUILD_BOOST_LEVELS as SHARED_GUILD_BOOST_LEVELS} from '@fluxer/constants/src/GuildBoostConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import type {LimitConfigSnapshot} from '@fluxer/limits/src/LimitTypes';
import {describe, expect, it} from 'vitest';

const NO_RULES: LimitConfigSnapshot = {traitDefinitions: [], rules: []};

describe('GUILD_BOOST_LEVELS', () => {
	it('shows the table the server decides levels from (@fluxer/constants)', () => {
		expect(GUILD_BOOST_LEVELS).toBe(SHARED_GUILD_BOOST_LEVELS);
	});
});

describe('getGuildBoostStatus', () => {
	it('takes the level from the server field and never recounts it from the boost count', () => {
		const status = getGuildBoostStatus({premiumTier: 1, premiumSubscriptionCount: 20});
		expect(status.level).toBe(1);
		expect(status.count).toBe(20);
		expect(status.next?.level).toBe(2);
	});

	it('reads missing server fields as no level and no boosts', () => {
		const status = getGuildBoostStatus({premiumTier: null, premiumSubscriptionCount: null});
		expect(status).toEqual({level: 0, count: 0, next: expect.objectContaining({level: 1, boosts: 2})});
	});

	it('has no next level at the top level', () => {
		expect(getGuildBoostStatus({premiumTier: 3, premiumSubscriptionCount: 14}).next).toBeNull();
	});
});

describe('getGuildBoostLevelPerks', () => {
	it('lists only what each level adds, with values from the instance limits', () => {
		const perks = getGuildBoostLevelPerks(NO_RULES);
		expect(perks.map((level) => level.perks)).toEqual([
			[{type: 'bitrate', kbps: 128}],
			[{type: 'bitrate', kbps: 256}],
			[{type: 'bitrate', kbps: 384}, {type: 'vanity_url'}],
		]);
	});

	it('shows the emoji and sticker slots an operator grants through limit rules', () => {
		const perks = getGuildBoostLevelPerks({
			traitDefinitions: [],
			rules: [
				{id: 'more-emoji', filters: {guildFeatures: [GuildFeatures.MORE_EMOJI]}, limits: {max_guild_emojis: 1000}},
				{
					id: 'more-stickers',
					filters: {guildFeatures: [GuildFeatures.MORE_STICKERS]},
					limits: {max_guild_stickers: 800},
				},
			],
		});
		expect(perks[0].perks).toContainEqual({type: 'emoji', count: 1000});
		expect(perks[1].perks).toContainEqual({type: 'stickers', count: 800});
		expect(perks[2].perks).not.toContainEqual(expect.objectContaining({type: 'emoji'}));
	});
});
