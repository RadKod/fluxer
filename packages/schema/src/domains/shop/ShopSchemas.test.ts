// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	AdminVisionaryGrantRequest,
	ApplyShopCampaignRequest,
	CreateShopBundleRequest,
	SetShopPricesRequest,
	SetVisionarySlotsRequest,
	UpdateShopBundleRequest,
	UpdateShopSettingsRequest,
} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import {
	CreateShopOrderRequest,
	PayriffCallbackParam,
	ShopSku,
} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';
import {describe, expect, it} from 'vitest';

describe('shop schemas', () => {
	it('takes cosmetic and 1, 3, 12 month skus only', () => {
		for (const sku of ['cosmetic:1490000000000000001', 'premium:1', 'premium:3', 'premium:12']) {
			expect(ShopSku.safeParse(sku).success).toBe(true);
		}
		for (const sku of ['cosmetic:0', 'cosmetic:abc', 'premium:2', 'premium:', 'store:1', ' premium:1']) {
			expect(ShopSku.safeParse(sku).success).toBe(false);
		}
	});

	it('holds item IDs to the int64 range', () => {
		expect(ShopSku.safeParse('cosmetic:9223372036854775807').success).toBe(true);
		expect(ShopSku.safeParse('cosmetic:9223372036854775808').success).toBe(false);
		expect(ShopSku.safeParse('cosmetic:9999999999999999999').success).toBe(false);
		expect(ShopSku.safeParse('cosmetic:10000000000000000000').success).toBe(false);
	});

	it('holds discounts to 0–95 and campaigns to 1–95', () => {
		expect(UpdateShopSettingsRequest.safeParse({premium_discount_percent: 96}).success).toBe(false);
		expect(UpdateShopSettingsRequest.safeParse({premium_discount_percent: 95}).success).toBe(true);
		expect(ApplyShopCampaignRequest.safeParse({skus: ['premium:1'], percent: 0, ends_at: null}).success).toBe(false);
		expect(ApplyShopCampaignRequest.safeParse({skus: ['premium:1'], percent: 95, ends_at: null}).success).toBe(true);
	});

	it('takes lira prices from ₺1 to ₺100 000 in kuruş and at most 200 rows', () => {
		expect(SetShopPricesRequest.safeParse({prices: [{sku: 'premium:1', base_try_minor: 99}]}).success).toBe(false);
		expect(SetShopPricesRequest.safeParse({prices: [{sku: 'premium:1', base_try_minor: 100}]}).success).toBe(true);
		expect(SetShopPricesRequest.safeParse({prices: [{sku: 'premium:1', base_try_minor: 10_000_001}]}).success).toBe(
			false,
		);
		const rows = Array.from({length: 201}, () => ({sku: 'premium:1', base_try_minor: 100}));
		expect(SetShopPricesRequest.safeParse({prices: rows}).success).toBe(false);
	});

	it('takes the only price field the client may send: none', () => {
		expect(CreateShopOrderRequest.parse({sku: 'premium:1', final_try_minor: 1})).toEqual({sku: 'premium:1'});
	});

	it('never refuses a Payriff callback path, however malformed', () => {
		for (const order_id of ['1490000000000000001', '0', 'abc', '99999999999999999999999', ' ']) {
			expect(PayriffCallbackParam.safeParse({order_id, token: 'x'.repeat(500)}).success).toBe(true);
		}
	});

	it('takes visionary as a bare sku only', () => {
		expect(ShopSku.safeParse('visionary').success).toBe(true);
		for (const sku of ['visionary:1', 'Visionary', 'visionary ', 'premium:visionary']) {
			expect(ShopSku.safeParse(sku).success).toBe(false);
		}
	});

	it('holds Visionary reward items to 10 and slots to 0–100000', () => {
		const ids = Array.from({length: 11}, (_, i) => String(1490000000000000001n + BigInt(i)));
		expect(UpdateShopSettingsRequest.safeParse({visionary_reward_item_ids: ids.slice(0, 10)}).success).toBe(true);
		expect(UpdateShopSettingsRequest.safeParse({visionary_reward_item_ids: ids}).success).toBe(false);
		expect(SetVisionarySlotsRequest.safeParse({total: 0}).success).toBe(true);
		expect(SetVisionarySlotsRequest.safeParse({total: -1}).success).toBe(false);
		expect(SetVisionarySlotsRequest.safeParse({total: 100_001}).success).toBe(false);
		expect(AdminVisionaryGrantRequest.safeParse({}).success).toBe(true);
		expect(AdminVisionaryGrantRequest.safeParse({slot: 0}).success).toBe(false);
	});

	it('takes bundle skus with an int64 bundle ID', () => {
		for (const sku of ['bundle:1', 'bundle:9223372036854775807']) {
			expect(ShopSku.safeParse(sku).success).toBe(true);
		}
		for (const sku of ['bundle:0', 'bundle:9223372036854775808', ' bundle:1', 'bundle:', 'bundle:abc', 'bundles:1']) {
			expect(ShopSku.safeParse(sku).success).toBe(false);
		}
	});

	it('holds a bundle to 2–10 items and its name and description to the cosmetic item limits', () => {
		const ids = Array.from({length: 11}, (_, i) => String(1490000000000000001n + BigInt(i)));
		const bundle = (item_ids: Array<string>) => CreateShopBundleRequest.safeParse({name: 'Melek', item_ids});
		expect(bundle(ids.slice(0, 1)).success).toBe(false);
		expect(bundle(ids.slice(0, 2)).success).toBe(true);
		expect(bundle(ids.slice(0, 10)).success).toBe(true);
		expect(bundle(ids).success).toBe(false);
		expect(CreateShopBundleRequest.safeParse({name: 'x'.repeat(65), item_ids: ids.slice(0, 2)}).success).toBe(false);
		expect(
			CreateShopBundleRequest.safeParse({name: 'Melek', description: 'x'.repeat(257), item_ids: ids.slice(0, 2)})
				.success,
		).toBe(false);
		expect(UpdateShopBundleRequest.safeParse({}).success).toBe(true);
		expect(UpdateShopBundleRequest.safeParse({item_ids: ids}).success).toBe(false);
	});
});
