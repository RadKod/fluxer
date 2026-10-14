// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';
import {
	bundleSku,
	computeShopPrice,
	describeShopOrder,
	formatRateMicro,
	isCampaignActive,
	isPaidPremiumForShop,
	isSellable,
	parseShopSku,
	roundHalfUpDiv,
	sellsAsCosmetic,
} from '@app/api/shop/ShopPricing';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {formatShopAzn, formatShopTry} from '@fluxer/schema/src/domains/shop/ShopPriceFormatting';
import {describe, expect, it} from 'vitest';

const NOW = new Date('2026-10-01T12:00:00Z');
const BASE = {
	baseUsdCents: 500,
	campaignPercent: null,
	campaignEndsAt: null,
	premiumPercent: 30,
	applyPremium: false,
	rateMicro: 1_700_000,
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
	it('formats shared shop prices across locale changes', () => {
		for (const locale of ['tr', 'en-US', 'tr']) {
			expect(formatShopTry(6800, locale)).toBe('68 TL');
			expect(formatShopTry(6801, locale)).toBe(locale === 'tr' ? '68,01 TL' : '68.01 TL');
			expect(formatShopAzn(338, locale)).toBe(locale === 'tr' ? '3,38' : '3.38');
		}
	});
	it('stacks a 20% campaign and a 30% premium discount: $5.00 → $4.00 → $2.80 → 4.76 AZN', () => {
		expect(computeShopPrice({...BASE, campaignPercent: 20, applyPremium: true})).toEqual({
			baseUsdCents: 500,
			campaignPercent: 20,
			campaignUsdCents: 400,
			premiumPercent: 30,
			finalUsdCents: 280,
			rateMicro: 1_700_000,
			amountAznMinor: 476,
		});
	});

	it('rounds half up at every step', () => {
		expect(roundHalfUpDiv(125 * 50, 100)).toBe(63);
		expect(roundHalfUpDiv(124 * 50, 100)).toBe(62);
		expect(computeShopPrice({...BASE, baseUsdCents: 125, campaignPercent: 50}).campaignUsdCents).toBe(63);
		expect(computeShopPrice({...BASE, baseUsdCents: 3, rateMicro: 1_500_000}).amountAznMinor).toBe(5); // 4.5 → 5
	});

	it('drops a campaign that ended by the server clock and keeps one with no end', () => {
		expect(
			computeShopPrice({...BASE, campaignPercent: 20, campaignEndsAt: new Date('2026-10-01T11:59:59Z')}).finalUsdCents,
		).toBe(500);
		expect(
			computeShopPrice({...BASE, campaignPercent: 20, campaignEndsAt: new Date('2026-10-01T12:00:01Z')}).finalUsdCents,
		).toBe(400);
		expect(isCampaignActive(20, null, NOW)).toBe(true);
		expect(isCampaignActive(null, null, NOW)).toBe(false);
	});

	it('applies the premium discount only when asked, never to packages', () => {
		expect(computeShopPrice({...BASE, applyPremium: false}).premiumPercent).toBe(0);
		expect(computeShopPrice({...BASE, applyPremium: false}).finalUsdCents).toBe(500);
	});

	it('charges USD times the rate in qepik', () => {
		expect(computeShopPrice(BASE).amountAznMinor).toBe(850);
	});

	it('marks a price below 1 cent or 0.10 AZN as not sellable', () => {
		expect(isSellable(computeShopPrice({...BASE, baseUsdCents: 1, campaignPercent: 95}))).toBe(false); // 0 cents
		expect(isSellable(computeShopPrice({...BASE, baseUsdCents: 5}))).toBe(false); // 8.5 → 9 qepik
		expect(isSellable(computeShopPrice({...BASE, baseUsdCents: 6}))).toBe(true); // 10.2 → 10 qepik
	});

	it('stays exact at the largest price and rate the admin can set', () => {
		const price = computeShopPrice({...BASE, baseUsdCents: 10_000_000, rateMicro: 3_000_000});
		expect(price.amountAznMinor).toBe(30_000_000);
		expect(Number.isSafeInteger(price.amountAznMinor)).toBe(true);
	});

	it('shows the rate with four places', () => {
		expect(formatRateMicro(1_700_000)).toBe('1.7000');
		expect(formatRateMicro(1_700_050)).toBe('1.7001');
		expect(formatRateMicro(2_999_999)).toBe('3.0000');
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
		expect(
			describeShopOrder(
				7n,
				{kind: 'premium', itemName: null, months},
				{
					display_currency: 'TRY',
					display_amount_minor: 6800n,
					amount_minor: 338,
				},
			),
		).toBe(
			`Micup Plus · ${months} ay — mağazadaki fiyat 68 TL. Bu ödeme Azerbaycan manatı ile alınır: 3,38 AZN. Sipariş #7`,
		);
	});

	it('describes an order with its Micup number for the Payriff panel', () => {
		const quote = {display_currency: 'TRY' as const, display_amount_minor: 6801n, amount_minor: 338};
		expect(
			describeShopOrder(1490000000000000009n, {kind: 'cosmetic', itemName: 'Yitik Melek', months: null}, quote),
		).toBe(
			'Yitik Melek — mağazadaki fiyat 68,01 TL. Bu ödeme Azerbaycan manatı ile alınır: 3,38 AZN. Sipariş #1490000000000000009',
		);
		expect(
			describeShopOrder(
				1n,
				{kind: 'premium', itemName: null, months: 1},
				{display_currency: 'AZN', display_amount_minor: 338n, amount_minor: 338},
			),
		).toBe('Micup Plus · 1 ay — mağazadaki fiyat 3,38 AZN. Sipariş #1');
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
		expect(astral).toContain(
			'… — mağazadaki fiyat 68,01 TL. Bu ödeme Azerbaycan manatı ile alınır: 3,38 AZN. Sipariş #9223372036854775807',
		);
		expect(astral).not.toMatch(/yaklaşık|kur farkı|fark olabilir/i);
	});

	it('describes a Visionary order', () => {
		expect(
			describeShopOrder(
				7n,
				{kind: 'visionary', itemName: null, months: null},
				{display_currency: 'TRY', display_amount_minor: 6800n, amount_minor: 338},
			),
		).toBe('Micup Visionary — mağazadaki fiyat 68 TL. Bu ödeme Azerbaycan manatı ile alınır: 3,38 AZN. Sipariş #7');
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
		const quote = {display_currency: 'TRY' as const, display_amount_minor: 6800n, amount_minor: 338};
		expect(describeShopOrder(7n, {kind: 'bundle', itemName: 'Melek Paketi', months: null}, quote)).toBe(
			'Melek Paketi — mağazadaki fiyat 68 TL. Bu ödeme Azerbaycan manatı ile alınır: 3,38 AZN. Sipariş #7',
		);
		const long = describeShopOrder(1n, {kind: 'bundle', itemName: 'x'.repeat(300), months: null}, quote);
		expect(long.length).toBe(200);
		expect(long).toContain('… — mağazadaki fiyat 68 TL.');
		expect(long.endsWith('Sipariş #1')).toBe(true);
	});
});
