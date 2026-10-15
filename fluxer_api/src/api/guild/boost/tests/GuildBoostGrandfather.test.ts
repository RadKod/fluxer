// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createVanityURLCode} from '@app/api/BrandedTypes';
import type {GuildBoostStateRow} from '@app/api/database/types/GuildBoostTypes';
import {guildBoostFeatures} from '@app/api/guild/boost/GuildBoostLevels';
import {GUILD_BOOST_VANITY_HOLD_MS, planGuildBoost} from '@app/api/guild/boost/GuildBoostService';
import {stripGuildBannerForFeatures, stripGuildIconForFeatures} from '@app/api/infrastructure/AssetEntitlementUtils';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {describe, expect, it} from 'vitest';

const deadline = new Date('2026-10-01T00:00:00Z');
const legacy = new Set([GuildFeatures.ANIMATED_ICON, GuildFeatures.ANIMATED_BANNER]);

function state(granted: Set<string>): GuildBoostStateRow {
	return {
		guild_id: createGuildID(900001n),
		boost_count: 0,
		premium_tier: 3,
		granted_features: granted,
		suppressed_features: null,
		downgrade_at: deadline,
		vanity_release_at: null,
		updated_at: deadline,
		version: 1,
	};
}

describe('boost grandfather and worker timing', () => {
	it('does not adopt independent raw animation grants at bootstrap or upgrade', () => {
		const guild = {features: legacy, premiumTier: 0, vanityUrlCode: null};
		for (const count of [0, 2, 7, 14]) {
			const plan = planGuildBoost(guild, count, null, deadline);
			for (const feature of legacy) {
				expect(plan.features).toContain(feature);
				expect(plan.granted).not.toContain(feature);
			}
		}
	});

	it('removes only boost grants at the persisted deadline and keeps grandfather assets', () => {
		const grants = guildBoostFeatures(3);
		for (const feature of legacy) grants.delete(feature);
		const guild = {features: new Set([...legacy, ...grants]), premiumTier: 3, vanityUrlCode: null};
		const plan = planGuildBoost(guild, 0, state(grants), deadline);
		expect(plan.tier).toBe(0);
		expect(plan.features).toEqual(legacy);
		expect(plan.granted.size).toBe(0);
	});

	it('keeps current asset grants until the hourly worker changes the raw features', () => {
		const grants = guildBoostFeatures(3);
		const guild = {features: grants, premiumTier: 3, vanityUrlCode: null};
		const afterDeadline = new Date(deadline.getTime() + 1);
		expect(stripGuildIconForFeatures('a_icon', legacy)).toBe('a_icon');
		expect(stripGuildBannerForFeatures('a_banner', new Set([...legacy, GuildFeatures.BANNER]))).toBe('a_banner');
		const plan = planGuildBoost(guild, 0, state(grants), afterDeadline);
		expect(stripGuildIconForFeatures('a_icon', plan.features)).toBe('icon');
		expect(stripGuildBannerForFeatures('a_banner', new Set([...plan.features, GuildFeatures.BANNER]))).toBe('banner');
	});

	it('anchors the vanity hold to the persisted deadline even when the worker is late', () => {
		const grants = guildBoostFeatures(3);
		const guild = {features: grants, premiumTier: 3, vanityUrlCode: createVanityURLCode('held-code')};
		const late = new Date(deadline.getTime() + 45 * 60 * 1000);
		const plan = planGuildBoost(guild, 0, state(grants), late);
		expect(plan.vanityReleaseAt?.getTime()).toBe(deadline.getTime() + GUILD_BOOST_VANITY_HOLD_MS);
		expect(plan.releaseVanity).toBe(false);
		const expired = planGuildBoost(guild, 0, state(grants), new Date(deadline.getTime() + GUILD_BOOST_VANITY_HOLD_MS));
		expect(expired.releaseVanity).toBe(true);
	});
});
