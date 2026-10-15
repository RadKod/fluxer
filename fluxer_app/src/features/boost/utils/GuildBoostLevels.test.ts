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
const LIMITS: LimitConfigSnapshot = {
	traitDefinitions: [],
	rules: GUILD_BOOST_LEVELS.map((level) => ({
		id: `boost-${level.level}`,
		filters: {guildFeatures: [`BOOST_LEVEL_${level.level}`]},
		limits: {...level.limits},
	})),
};

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
	it.each([
		[0, false, false, false, 720, 30, 8, 96, 500, 500, false, false, null, 500, 250],
		[1, true, false, false, 720, 60, 24, 128, 1000, 500, true, false, null, 500, 250],
		[2, true, false, false, 1080, 60, 36, 256, 1250, 1000, true, true, 50_000_000, 600, 300],
		[3, true, true, true, 1080, 60, 48, 384, 1500, 1250, true, true, 100_000_000, 750, 350],
	])('shows all 13 effective contract rows for level %i', (...expected) => {
		const [
			level,
			icon,
			banner,
			vanity,
			height,
			fps,
			sounds,
			kbps,
			emoji,
			stickers,
			icons,
			gradient,
			bytes,
			channels,
			roles,
		] = expected;
		const card = getGuildBoostLevelPerks(LIMITS).find((candidate) => candidate.level === level)!;
		expect(card.perks).toEqual([
			{type: 'animated_icon', available: icon},
			{type: 'animated_banner', available: banner},
			{type: 'static_banner', available: true},
			{type: 'vanity_url', available: vanity},
			{type: 'video', height, fps},
			{type: 'soundboard', count: sounds},
			{type: 'bitrate', kbps},
			{type: 'emoji', count: emoji},
			{type: 'stickers', count: stickers},
			{type: 'role_icons', available: icons},
			{type: 'role_gradient', available: gradient},
			{type: 'file', bytes},
			{type: 'capacity', channels, roles},
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
		expect(perks[1].perks).toContainEqual({type: 'emoji', count: 1000});
		expect(perks[2].perks).toContainEqual({type: 'stickers', count: 800});
		expect(perks[3].perks).toContainEqual({type: 'emoji', count: 1000});
	});

	it('uses configured limits rather than promising table values when level rules are missing', () => {
		const card = getGuildBoostLevelPerks(NO_RULES)[3];
		expect(card.perks).toContainEqual({type: 'soundboard', count: 8});
		expect(card.perks).toContainEqual({type: 'video', height: 720, fps: 30});
		expect(card.perks).toContainEqual({type: 'file', bytes: null});
	});

	it('shows independent and grandfather grants from the authoritative current guild features', () => {
		const card = getGuildBoostLevelPerks(LIMITS, {
			premiumTier: 0,
			features: new Set([
				GuildFeatures.BANNER,
				GuildFeatures.INVITE_SPLASH,
				GuildFeatures.ANIMATED_ICON,
				GuildFeatures.ANIMATED_BANNER,
				GuildFeatures.UNLIMITED_EMOJI,
				GuildFeatures.UNLIMITED_STICKERS,
			]),
		})[0];
		expect(card.perks).toContainEqual({type: 'animated_icon', available: true});
		expect(card.perks).toContainEqual({type: 'animated_banner', available: true});
		expect(card.perks).toContainEqual({type: 'emoji', count: Number.POSITIVE_INFINITY});
		expect(card.perks).toContainEqual({type: 'stickers', count: Number.POSITIVE_INFINITY});
	});

	it('does not grant suppressed assets from premiumTier alone on the current card', () => {
		const card = getGuildBoostLevelPerks(LIMITS, {premiumTier: 3, features: new Set()})[3];
		expect(card.perks).toContainEqual({type: 'animated_icon', available: false});
		expect(card.perks).toContainEqual({type: 'animated_banner', available: false});
	});
});
