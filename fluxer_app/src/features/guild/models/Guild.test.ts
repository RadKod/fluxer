// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Guild as WireGuild} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/guild/models/GuildRole', () => ({GuildRole: class {}}));
vi.mock('@app/features/theme/fonts/ScriptFontLoader', () => ({noteText: () => {}}));

const {Guild} = await import('@app/features/guild/models/Guild');

function wireGuild(extra: Partial<WireGuild> = {}): WireGuild {
	return {
		id: '10',
		name: 'sanalyer',
		icon: null,
		vanity_url_code: null,
		owner_id: '1',
		system_channel_id: null,
		features: [],
		...extra,
	};
}

describe('Guild boost fields', () => {
	it('reads null when the server sends no boost state', () => {
		const guild = new Guild(wireGuild());
		expect(guild.premiumTier).toBeNull();
		expect(guild.premiumSubscriptionCount).toBeNull();
	});

	it('maps the boost tier and count', () => {
		const guild = new Guild(wireGuild({premium_tier: 2, premium_subscription_count: 7}));
		expect([guild.premiumTier, guild.premiumSubscriptionCount]).toEqual([2, 7]);
		expect(guild.toJSON()).toMatchObject({premium_tier: 2, premium_subscription_count: 7});
	});

	it('keeps the boost state when rebuilt from itself and applies a new one', () => {
		const guild = new Guild(wireGuild({premium_tier: 2, premium_subscription_count: 7}));
		const renamed = new Guild({...guild.toJSON(), name: 'sanalyer TR'});
		expect([renamed.premiumTier, renamed.premiumSubscriptionCount]).toEqual([2, 7]);
		const boosted = new Guild({...guild.toJSON(), premium_tier: 3, premium_subscription_count: 14});
		expect([boosted.premiumTier, boosted.premiumSubscriptionCount]).toEqual([3, 14]);
	});
});
