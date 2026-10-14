// SPDX-License-Identifier: AGPL-3.0-or-later

import {formatPerkValue, getPerkLabel} from '@app/features/app/components/dialogs/components/FeatureComparisonTable';
import {COMMUNITIES_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {PREMIUM_DECORATIONS_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import {
	isBooleanTierPerk,
	isNumericTierPerk,
	LIMIT_TIER_PERKS,
	type LimitTierPerk,
	type NumericTierPerk,
} from '@fluxer/constants/src/LimitTierPerks';
import {DEFAULT_RESTRICTED_LIMITS, DEFAULT_STOCK_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';

const APPEARANCE_DESCRIPTOR = msg({
	message: 'Appearance',
	comment: 'Group heading in the Plus page table comparing the free plan with Plus.',
});
const CHAT_AND_MEDIA_DESCRIPTOR = msg({
	message: 'Chat and media',
	comment: 'Group heading in the Plus page table comparing the free plan with Plus.',
});
const VOICE_AND_VIDEO_DESCRIPTOR = msg({
	message: 'Voice and video',
	comment: 'Group heading in the Plus page table comparing the free plan with Plus.',
});
const OTHER_DESCRIPTOR = msg({
	message: 'Other',
	comment: 'Group heading in the Plus page table comparing the free plan with Plus.',
});
export const SPECIAL_DISCOUNTS_IN_SHOP_DESCRIPTOR = msg({
	message: 'Special discounts in the shop',
	comment: 'Plus perk: members pay less for shop decorations. Perk tile title and comparison table row.',
});
const COMMUNITY_BOOSTS_DESCRIPTOR = msg({
	message: 'Community boosts',
	comment: 'Comparison table row on the Plus page: how many communities the user can boost.',
});

// A cell is a yes or no (drawn as a check or a cross) or a value such as "500 MB".
export type PremiumCompareCell = boolean | string;

export interface PremiumCompareRow {
	id: string;
	label: string;
	beta: boolean;
	free: PremiumCompareCell;
	premium: PremiumCompareCell;
}

export type PremiumCompareGroupId = 'appearance' | 'chat_media' | 'voice_video' | 'communities' | 'other';

export interface PremiumCompareGroup {
	id: PremiumCompareGroupId;
	label: string;
	rows: Array<PremiumCompareRow>;
}

export interface PremiumCompareInput {
	// The catalog has an item every premium member can wear.
	hasIncludedDecorations: boolean;
	// The premium member discount in the shop, 0 when off.
	shopDiscountPercent: number;
}

// Micup rows beside Fluxer's LIMIT_TIER_PERKS ids.
const INCLUDED_DECORATIONS = 'included_decorations';
const SHOP_DISCOUNT = 'shop_discount';
const BOOST_SLOTS = 'boost_slots';

// Boost slots are a live user limit, not one of Fluxer's tier perks.
const BOOST_SLOTS_PERK: NumericTierPerk = {
	id: BOOST_SLOTS,
	type: 'numeric',
	status: 'available',
	i18nKey: BOOST_SLOTS,
	restrictedValue: DEFAULT_RESTRICTED_LIMITS.max_boost_slots,
	stockValue: DEFAULT_STOCK_LIMITS.max_boost_slots,
	limitKey: 'max_boost_slots',
	unit: 'count',
};

// Discord's single table, by group. A tier perk missing here goes under Other, so an upstream perk still shows.
const GROUPS: ReadonlyArray<{id: PremiumCompareGroupId; label: MessageDescriptor; rows: ReadonlyArray<string>}> = [
	{
		id: 'appearance',
		label: APPEARANCE_DESCRIPTOR,
		rows: [
			'profile_badge',
			'animated_profile',
			'per_guild_profiles',
			'custom_themes',
			INCLUDED_DECORATIONS,
			SHOP_DISCOUNT,
		],
	},
	{
		id: 'chat_media',
		label: CHAT_AND_MEDIA_DESCRIPTOR,
		rows: [
			'max_message_length',
			'max_attachment_file_size',
			'global_expressions',
			'use_animated_emojis',
			'max_bookmarks',
			'max_favorite_memes',
		],
	},
	{
		id: 'voice_video',
		label: VOICE_AND_VIDEO_DESCRIPTOR,
		rows: ['video_quality', 'custom_video_backgrounds', 'entrance_sounds'],
	},
	{id: 'communities', label: COMMUNITIES_DESCRIPTOR, rows: ['max_guilds', BOOST_SLOTS]},
	{id: 'other', label: OTHER_DESCRIPTOR, rows: ['early_access']},
];

function perkRow(i18n: I18n, perk: LimitTierPerk, label: string): PremiumCompareRow {
	const beta = perk.status === 'beta';
	if (isBooleanTierPerk(perk)) return {id: perk.id, label, beta, free: perk.restrictedValue, premium: perk.stockValue};
	if (isNumericTierPerk(perk)) {
		return {
			id: perk.id,
			label,
			beta,
			free: formatPerkValue(i18n, perk, perk.restrictedValue, false),
			premium: formatPerkValue(i18n, perk, perk.stockValue, true),
		};
	}
	return {
		id: perk.id,
		label,
		beta,
		free: getPerkLabel(i18n, perk.restrictedValueI18nKey),
		premium: getPerkLabel(i18n, perk.stockValueI18nKey),
	};
}

// The premium page table. A row is only promised when its live free and premium
// values differ (design K11), so free-for-all perks such as animated emojis never show.
export function getPremiumCompareGroups(i18n: I18n, input: PremiumCompareInput): Array<PremiumCompareGroup> {
	const perks = LIMIT_TIER_PERKS.filter((perk) => perk.status !== 'coming_soon' && perk.id !== 'custom_discriminator');
	const placed = new Set(GROUPS.flatMap((group) => group.rows));
	const rowFor = (id: string): PremiumCompareRow | null => {
		if (id === INCLUDED_DECORATIONS) {
			if (!input.hasIncludedDecorations) return null;
			return {id, label: i18n._(PREMIUM_DECORATIONS_DESCRIPTOR), beta: false, free: false, premium: true};
		}
		if (id === SHOP_DISCOUNT) {
			if (input.shopDiscountPercent <= 0) return null;
			return {id, label: i18n._(SPECIAL_DISCOUNTS_IN_SHOP_DESCRIPTOR), beta: false, free: false, premium: true};
		}
		if (id === BOOST_SLOTS) return perkRow(i18n, BOOST_SLOTS_PERK, i18n._(COMMUNITY_BOOSTS_DESCRIPTOR));
		const perk = perks.find((candidate) => candidate.id === id);
		return perk ? perkRow(i18n, perk, getPerkLabel(i18n, perk.i18nKey)) : null;
	};
	return GROUPS.map(({id, label, rows}) => {
		const ids =
			id === 'other' ? [...rows, ...perks.filter((perk) => !placed.has(perk.id)).map((perk) => perk.id)] : rows;
		return {
			id,
			label: i18n._(label),
			rows: ids.flatMap((rowId) => {
				const row = rowFor(rowId);
				return row && row.free !== row.premium ? [row] : [];
			}),
		};
	}).filter((group) => group.rows.length > 0);
}
