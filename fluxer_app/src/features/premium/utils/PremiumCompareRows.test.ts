// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const i18n = setupI18n({locale: 'en', messages: {en: {}}});
// Live limit values by key; a key missing here resolves to the perk's own default.
const limits = vi.hoisted(() => ({free: {} as Record<string, number>, premium: {} as Record<string, number>}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
// The perk labels live in the upstream comparison table module, which also draws with the React macros.
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n}), Trans: () => null}));
vi.mock('@app/features/app/utils/UserLimits', () => ({
	Limits: {
		getStockValue: (key: string, fallback: number) => limits.premium[key] ?? fallback,
		getRestrictedValue: (key: string, fallback: number) => limits.free[key] ?? fallback,
	},
}));

const {getPremiumCompareGroups} = await import('@app/features/premium/utils/PremiumCompareRows');

const rich = {hasIncludedDecorations: true, shopDiscountPercent: 30};
const groups = (input = rich) => getPremiumCompareGroups(i18n, input);
const row = (id: string, input = rich) =>
	groups(input)
		.flatMap((group) => group.rows)
		.find((candidate) => candidate.id === id);

describe('getPremiumCompareGroups', () => {
	beforeEach(() => {
		limits.free = {};
		limits.premium = {};
	});

	it('lists the groups and rows in the fixed order', () => {
		expect(groups().map((group) => [group.label, group.rows.map((r) => r.id)])).toEqual([
			[
				'Appearance',
				['profile_badge', 'animated_profile', 'per_guild_profiles', 'included_decorations', 'shop_discount'],
			],
			[
				'Chat and media',
				['max_message_length', 'max_attachment_file_size', 'global_expressions', 'max_bookmarks', 'max_favorite_memes'],
			],
			['Voice and video', ['video_quality', 'custom_video_backgrounds', 'entrance_sounds']],
			['Communities', ['max_guilds', 'boost_slots']],
			['Other', ['early_access']],
		]);
	});

	it('leaves out a perk the free plan has as well', () => {
		const ids = groups().flatMap((group) => group.rows.map((r) => r.id));
		// Animated emojis and custom themes are on for free accounts too.
		expect(ids).not.toContain('use_animated_emojis');
		expect(ids).not.toContain('custom_themes');

		limits.free = {max_bookmarks: 300};
		expect(row('max_bookmarks')).toBeUndefined();
	});

	it('marks beta perks', () => {
		expect(row('max_favorite_memes')?.beta).toBe(true);
		expect(row('entrance_sounds')?.beta).toBe(true);
		expect(row('custom_video_backgrounds')?.beta).toBe(true);
		expect(row('max_message_length')?.beta).toBe(false);
	});

	it('shows included decorations only when the catalog has a premium item', () => {
		expect(row('included_decorations')).toMatchObject({label: 'Plus decorations', free: false, premium: true});
		expect(row('included_decorations', {...rich, hasIncludedDecorations: false})).toBeUndefined();
	});

	it('shows the shop discount only above 0', () => {
		expect(row('shop_discount')).toMatchObject({label: 'Special discounts in the shop', free: false, premium: true});
		expect(row('shop_discount', {...rich, shopDiscountPercent: 0})).toBeUndefined();
	});

	it('reads numbers and boosts from the live limits', () => {
		expect(row('max_message_length')).toMatchObject({free: '2,000', premium: '4,000'});
		expect(row('boost_slots')).toMatchObject({label: 'Community boosts', free: '0', premium: '2'});
		expect(row('max_attachment_file_size')?.free).toMatch(/^25\s?MB$/);

		limits.free = {max_message_length: 3000};
		limits.premium = {max_boost_slots: 5};
		expect(row('max_message_length')).toMatchObject({free: '3,000', premium: '4,000'});
		expect(row('boost_slots')).toMatchObject({free: '0', premium: '5'});

		limits.premium = {max_boost_slots: 0};
		expect(row('boost_slots')).toBeUndefined();
	});

	it('writes yes or no perks as booleans and text perks as their labels', () => {
		expect(row('profile_badge')).toMatchObject({label: 'Profile badge', free: false, premium: true});
		expect(row('video_quality')).toMatchObject({free: '720p/30fps', premium: 'Up to 4K/60fps'});
	});

	it('drops a group left without rows', () => {
		limits.premium = {max_guilds: 100, max_boost_slots: 0};
		expect(groups().map((group) => group.id)).not.toContain('communities');
	});
});
