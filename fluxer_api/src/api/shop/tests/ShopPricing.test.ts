// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';
import {
	bundleSku,
	computeShopPrice,
	describeShopOrder,
	isCampaignActive,
	isPaidPremiumForShop,
	isSellable,
	parseShopSku,
	roundHalfUpDiv,
	sellsAsCosmetic,
} from '@app/api/shop/ShopPricing';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {formatShopTry} from '@fluxer/schema/src/domains/shop/ShopPriceFormatting';
import {describe, expect, it} from 'vitest';

const NOW = new Date('2026-10-01T12:00:00Z');
const BASE = {
	baseTryMinor: 50_000,
	campaignPercent: null,
	campaignEndsAt: null,
	premiumPercent: 30,
	applyPremium: false,
	now: NOW,
};

function userWith(premiumType: number | null, premiumUntil: Date | null): User {
	return new User({
		...EMPTY_USER_ROW,
		user_id: 1490000000000000001n as UserID,
		premium_type: premiumType,
		premium_until: premiumUntil,
	});
}

const premiumUser = () => userWith(UserPremiumTypes.SUBSCRIPTION, new Date(Date.now() + 30 * 86_400_000));
const freeUser = () => userWith(null, null);

describe('shop pricing', () => {
	it('formats lira prices for the locale, whole lira without decimals', () => {
		for (const locale of ['tr', 'en-US', 'tr']) {
			expect(formatShopTry(6800, locale)).toBe('₺68');
			expect(formatShopTry(6801, locale)).toBe(locale === 'tr' ? '₺68,01' : '₺68.01');
			expect(formatShopTry(6850, locale)).toBe(locale === 'tr' ? '₺68,50' : '₺68.50');
		}
		expect(formatShopTry(125_000, 'tr')).toBe('₺1.250');
	});

	it('stacks a 20% campaign and a 30% premium discount: ₺500 → ₺400 → ₺280', () => {
		expect(computeShopPrice({...BASE, campaignPercent: 20, applyPremium: true})).toEqual({
			baseTryMinor: 50_000,
			campaignPercent: 20,
			campaignTryMinor: 40_000,
			premiumPercent: 30,
			finalTryMinor: 28_000,
		});
	});

	it('rounds half up at every step', () => {
		expect(roundHalfUpDiv(125 * 50, 100)).toBe(63);
		expect(roundHalfUpDiv(124 * 50, 100)).toBe(62);
		expect(computeShopPrice({...BASE, baseTryMinor: 125, campaignPercent: 50}).campaignTryMinor).toBe(63);
		// 999 × 0.7 = 699.3 → 699; 1 005 × 0.5 = 502.5 → 503
		expect(computeShopPrice({...BASE, baseTryMinor: 999, applyPremium: true}).finalTryMinor).toBe(699);
		expect(computeShopPrice({...BASE, baseTryMinor: 1005, campaignPercent: 50}).finalTryMinor).toBe(503);
	});

	it('drops a campaign that ended by the server clock and keeps one with no end', () => {
		expect(
			computeShopPrice({...BASE, campaignPercent: 20, campaignEndsAt: new Date('2026-10-01T11:59:59Z')}).finalTryMinor,
		).toBe(50_000);
		expect(
			computeShopPrice({...BASE, campaignPercent: 20, campaignEndsAt: new Date('2026-10-01T12:00:01Z')}).finalTryMinor,
		).toBe(40_000);
		expect(isCampaignActive(20, null, NOW)).toBe(true);
		expect(isCampaignActive(null, null, NOW)).toBe(false);
	});

	it('applies the premium discount only when asked, never to packages', () => {
		expect(computeShopPrice({...BASE, applyPremium: false}).premiumPercent).toBe(0);
		expect(computeShopPrice({...BASE, applyPremium: false}).finalTryMinor).toBe(50_000);
	});

	it('charges the list price in kuruş without any conversion', () => {
		expect(computeShopPrice(BASE).finalTryMinor).toBe(50_000);
	});

	it('marks a price below ₺1 as not sellable', () => {
		expect(isSellable(computeShopPrice({...BASE, baseTryMinor: 100, campaignPercent: 95}))).toBe(false); // 5 kuruş
		expect(isSellable(computeShopPrice({...BASE, baseTryMinor: 99}))).toBe(false);
		expect(isSellable(computeShopPrice({...BASE, baseTryMinor: 100}))).toBe(true);
	});

	it('stays exact at the largest price the admin can set', () => {
		const price = computeShopPrice({...BASE, baseTryMinor: 10_000_000, campaignPercent: 1, applyPremium: true});
		expect(Number.isSafeInteger(price.finalTryMinor)).toBe(true);
		expect(price.finalTryMinor).toBe(6_930_000);
	});

	it('reads cosmetic and 1, 3, 12 month skus', () => {
		expect(parseShopSku('cosmetic:1490000000000000001')).toEqual({kind: 'cosmetic', itemId: 1490000000000000001n});
		expect(parseShopSku('premium:12')).toEqual({kind: 'premium', months: 12});
		expect(parseShopSku('premium:2')).toBeNull();
		expect(parseShopSku('cosmetic:9223372036854775808')).toBeNull();
		expect(parseShopSku('cosmetic:0')).toBeNull();
	});

	it('reads the visionary sku', () => {
		expect(parseShopSku('visionary')).toEqual({kind: 'visionary'});
		expect(parseShopSku('visionary:1')).toBeNull();
	});

	it('gives the premium discount to paid premium and not to a trial', () => {
		const premium = premiumUser();
		const trialStart = new Date('2026-09-28T10:00:00Z');
		expect(isPaidPremiumForShop(premium, null)).toBe(true);
		expect(isPaidPremiumForShop(premium, {trial_used_at: trialStart, applied_grants: null})).toBe(false);
		expect(
			isPaidPremiumForShop(premium, {
				trial_used_at: trialStart,
				applied_grants: new Map([['gift:x', new Date('2026-09-27T10:00:00Z')]]),
			}),
		).toBe(false);
		expect(
			isPaidPremiumForShop(premium, {
				trial_used_at: trialStart,
				applied_grants: new Map([['payriff:1', new Date('2026-09-29T10:00:00Z')]]),
			}),
		).toBe(true);
		expect(isPaidPremiumForShop(freeUser(), null)).toBe(false);
	});

	it('a Visionary gets the member discount even after a trial', () => {
		const visionary = userWith(UserPremiumTypes.LIFETIME, null);
		expect(
			isPaidPremiumForShop(visionary, {trial_used_at: new Date('2026-09-28T10:00:00Z'), applied_grants: null}),
		).toBe(true);
	});

	it.each([1, 3, 12])('describes Plus %i months with its frozen quote', (months) => {
		expect(describeShopOrder(7n, {kind: 'premium', itemName: null, months}, {amount_minor: 6800})).toBe(
			`sanalyer Plus · ${months} ay — ₺68. Sipariş #7`,
		);
	});

	it('describes an order with its sanalyer number for the payment provider panel', () => {
		const quote = {amount_minor: 6801};
		expect(
			describeShopOrder(1490000000000000009n, {kind: 'cosmetic', itemName: 'Yitik Melek', months: null}, quote),
		).toBe('Yitik Melek — ₺68,01. Sipariş #1490000000000000009');
		expect(
			describeShopOrder(1n, {kind: 'cosmetic', itemName: 'x'.repeat(300), months: null}, quote).length,
		).toBeLessThanOrEqual(200);
		const astral = describeShopOrder(
			9223372036854775807n,
			{kind: 'cosmetic', itemName: '🪽'.repeat(150), months: null},
			quote,
		);
		expect(astral.length).toBeLessThanOrEqual(200);
		expect(astral.isWellFormed()).toBe(true);
		expect(astral).toContain('… — ₺68,01. Sipariş #9223372036854775807');
	});

	it('describes a Visionary order', () => {
		expect(describeShopOrder(7n, {kind: 'visionary', itemName: null, months: null}, {amount_minor: 6800})).toBe(
			'sanalyer Visionary — ₺68. Sipariş #7',
		);
	});

	it('reads bundle skus with an int64 bundle ID', () => {
		expect(parseShopSku('bundle:1490000000000000001')).toEqual({kind: 'bundle', bundleId: 1490000000000000001n});
		expect(parseShopSku('bundle:9223372036854775807')).toEqual({kind: 'bundle', bundleId: 9223372036854775807n});
		for (const sku of ['bundle:0', 'bundle:9223372036854775808', 'bundle:', ' bundle:1', 'bundle:1 ']) {
			expect(parseShopSku(sku)).toBeNull();
		}
		expect(bundleSku(1490000000000000001n)).toBe('bundle:1490000000000000001');
		expect(parseShopSku(bundleSku(7n))).toEqual({kind: 'bundle', bundleId: 7n});
	});

	it('sells items and bundles as cosmetics, premium and Visionary not', () => {
		expect(sellsAsCosmetic(parseShopSku('cosmetic:1'))).toBe(true);
		expect(sellsAsCosmetic(parseShopSku('bundle:1'))).toBe(true);
		expect(sellsAsCosmetic(parseShopSku('premium:1'))).toBe(false);
		expect(sellsAsCosmetic(parseShopSku('visionary'))).toBe(false);
		expect(sellsAsCosmetic(null)).toBe(false);
	});

	it('describes a bundle order with the bundle name, cut to 200 characters', () => {
		const quote = {amount_minor: 6800};
		expect(describeShopOrder(7n, {kind: 'bundle', itemName: 'Melek Paketi', months: null}, quote)).toBe(
			'Melek Paketi — ₺68. Sipariş #7',
		);
		const long = describeShopOrder(1n, {kind: 'bundle', itemName: 'x'.repeat(300), months: null}, quote);
		expect(long.length).toBe(200);
		expect(long).toContain('… — ₺68.');
		expect(long.endsWith('Sipariş #1')).toBe(true);
	});
});
