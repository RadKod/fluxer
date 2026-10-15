// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {InstanceConfigurationRow} from '@app/api/database/types/InstanceConfigTypes';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getAdminRepository} from '@app/api/middleware/ServiceSingletons';
import {createShopAdmin, createShopItem, saveShopEnvironment} from '@app/api/shop/tests/ShopTestUtils';
import {InstanceConfiguration} from '@app/api/Tables';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {ShopAdminResponse, ShopAdminSettingsResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const FUTURE = '2099-01-01T00:00:00.000Z';

describe('shop admin', () => {
	let harness: ApiTestHarness;
	let restoreEnvironment: () => void;
	let admin: TestAccount;

	beforeAll(async () => {
		restoreEnvironment = saveShopEnvironment();
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		admin = await createShopAdmin(harness);
	});
	afterEach(() => vi.useRealTimers());

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	function view() {
		return createBuilder<ShopAdminResponse>(harness, admin.token).get('/admin/shop').execute();
	}

	function patchSettings(body: Record<string, unknown>, status = 200) {
		return createBuilder<ShopAdminSettingsResponse>(harness, admin.token)
			.patch('/admin/shop/settings')
			.body(body)
			.expect(status)
			.execute();
	}

	function putPrices(prices: Array<{sku: string; base_try_minor: number | null}>, status = 200) {
		return createBuilder<ShopAdminResponse>(harness, admin.token)
			.put('/admin/shop/prices')
			.body({prices})
			.expect(status)
			.execute();
	}

	function campaign(body: Record<string, unknown>, status = 200) {
		return createBuilder<ShopAdminResponse>(harness, admin.token)
			.post('/admin/shop/campaigns')
			.body(body)
			.expect(status)
			.execute();
	}

	async function auditMetadata(action: string): Promise<Array<Record<string, string>>> {
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		return logs.filter((log) => log.action === action).map((log) => Object.fromEntries(log.metadata));
	}

	it('needs SHOP_MANAGE; COSMETICS_MANAGE alone is refused', async () => {
		const cosmeticsAdmin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.COSMETICS_MANAGE,
		]);
		const requests = [
			createBuilder(harness, cosmeticsAdmin.token).get('/admin/shop'),
			createBuilder(harness, cosmeticsAdmin.token).patch('/admin/shop/settings').body({item_sales_open: true}),
			createBuilder(harness, cosmeticsAdmin.token)
				.put('/admin/shop/prices')
				.body({prices: [{sku: 'premium:1', base_try_minor: 500}]}),
			createBuilder(harness, cosmeticsAdmin.token)
				.post('/admin/shop/campaigns')
				.body({skus: ['premium:1'], percent: 20, ends_at: null}),
			createBuilder(harness, cosmeticsAdmin.token)
				.post('/admin/shop/campaigns/remove')
				.body({skus: ['premium:1']}),
		];
		for (const request of requests) {
			await request.expect(403, APIErrorCodes.MISSING_ACL).execute();
		}
		expect((await view()).prices).toEqual([]);
	});

	it('stores the settings under the shop_config key', async () => {
		const settings = await patchSettings({premium_sales_open: true, premium_discount_percent: 25});

		expect(settings).toEqual({
			premium_sales_open: true,
			item_sales_open: false,
			premium_discount_percent: 25,
			payment_provider_configured: true,
			visionary_on_sale: false,
			visionary_reward_item_ids: [],
			early_plus_badge_id: null,
			early_plus_open: false,
			early_plus_opened_once: false,
		});
		const row = await fetchOne<InstanceConfigurationRow>(
			InstanceConfiguration.selectCql({where: InstanceConfiguration.where.eq('key'), limit: 1}),
			{key: 'shop_config'},
		);
		expect(JSON.parse(row!.value!)).toEqual({
			premium_sales_open: true,
			item_sales_open: false,
			premium_discount_percent: 25,
			visionary_on_sale: false,
			visionary_reward_item_ids: [],
			early_plus_badge_id: null,
			early_plus_open: false,
			early_plus_opened_once: false,
		});
		expect((await view()).settings).toEqual(settings);
	});

	it('starts with both sales closed and reports no payment provider without a Payriff key', async () => {
		const previous = Config.payriff.enabled;
		Config.payriff.enabled = false;
		try {
			expect((await view()).settings).toMatchObject({
				premium_sales_open: false,
				item_sales_open: false,
				payment_provider_configured: false,
			});
		} finally {
			Config.payriff.enabled = previous;
		}
	});

	it('refuses a discount above 95, a price below ₺1 and one above ₺100 000', async () => {
		await patchSettings({premium_discount_percent: 96}, 400);
		await putPrices([{sku: 'premium:1', base_try_minor: 99}], 400);
		await putPrices([{sku: 'premium:1', base_try_minor: 0}], 400);
		await putPrices([{sku: 'premium:1', base_try_minor: 10_000_001}], 400);

		await putPrices([{sku: 'premium:1', base_try_minor: 100}]);
		expect((await view()).prices.map(({sku, base_try_minor}) => [sku, base_try_minor])).toEqual([['premium:1', 100]]);
		expect((await view()).settings.premium_discount_percent).toBe(0);
	});

	it('refuses a settings change that would push a priced item below ₺1', async () => {
		const item = await createShopItem(harness, admin, 'owned');
		await putPrices([
			{sku: `cosmetic:${item.id}`, base_try_minor: 150},
			{sku: 'premium:1', base_try_minor: 105},
		]);

		await patchSettings({premium_discount_percent: 50}, 400); // 150 → 75 kuruş
		await putPrices([{sku: `cosmetic:${item.id}`, base_try_minor: 200}]);
		await patchSettings({premium_discount_percent: 50}); // 200 → 100 kuruş

		expect((await view()).settings).toMatchObject({premium_discount_percent: 50});
		await campaign({skus: [`cosmetic:${item.id}`], percent: 50, ends_at: null}, 400); // 200 → 100 → 50 kuruş
		await campaign({skus: ['premium:1'], percent: 10, ends_at: null}, 400); // 105 → 94.5 → 95 kuruş
	});

	it('takes prices only for owned items and 1, 3, 12 month packages', async () => {
		const owned = await createShopItem(harness, admin, 'owned');
		const free = await createShopItem(harness, admin, 'free');
		const premium = await createShopItem(harness, admin, 'premium');

		await putPrices([{sku: `cosmetic:${free.id}`, base_try_minor: 500}], 400);
		await putPrices([{sku: `cosmetic:${premium.id}`, base_try_minor: 500}], 400);
		await putPrices([{sku: 'cosmetic:1490000000000000001', base_try_minor: 500}], 400);
		await putPrices([{sku: 'premium:2', base_try_minor: 500}], 400);

		const response = await putPrices([
			{sku: `cosmetic:${owned.id}`, base_try_minor: 500},
			{sku: 'premium:1', base_try_minor: 500},
			{sku: 'premium:3', base_try_minor: 1300},
			{sku: 'premium:12', base_try_minor: 4800},
		]);
		expect(response.prices.map(({sku}) => sku).sort()).toEqual(
			[`cosmetic:${owned.id}`, 'premium:1', 'premium:12', 'premium:3'].sort(),
		);
		expect(response.prices.find(({sku}) => sku === 'premium:3')).toEqual({
			sku: 'premium:3',
			base_try_minor: 1300,
			campaign_percent: null,
			campaign_ends_at: null,
			now: {
				base_try_minor: 1300,
				campaign_percent: null,
				campaign_ends_at: null,
				sale_try_minor: 1300,
				premium_try_minor: null,
			},
		});

		const removed = await putPrices([{sku: 'premium:3', base_try_minor: null}]);
		expect(removed.prices.map(({sku}) => sku)).not.toContain('premium:3');
	});

	it('applies a campaign to several products and removes it', async () => {
		const item = await createShopItem(harness, admin, 'owned');
		await putPrices([
			{sku: `cosmetic:${item.id}`, base_try_minor: 500},
			{sku: 'premium:1', base_try_minor: 500},
			{sku: 'premium:3', base_try_minor: 1300},
		]);

		await campaign({skus: ['premium:12'], percent: 20, ends_at: null}, 400);
		await campaign({skus: ['premium:1'], percent: 20, ends_at: '2020-01-01T00:00:00.000Z'}, 400);
		const applied = await campaign({skus: [`cosmetic:${item.id}`, 'premium:1'], percent: 20, ends_at: FUTURE});
		const row = (sku: string) => applied.prices.find((price) => price.sku === sku)!;
		expect(row('premium:1')).toMatchObject({
			campaign_percent: 20,
			campaign_ends_at: FUTURE,
			now: {campaign_percent: 20, campaign_ends_at: FUTURE, sale_try_minor: 400},
		});
		expect(row(`cosmetic:${item.id}`).now.sale_try_minor).toBe(400);
		expect(row('premium:3').campaign_percent).toBeNull();

		const repriced = await putPrices([{sku: 'premium:1', base_try_minor: 600}]);
		expect(repriced.prices.find((price) => price.sku === 'premium:1')).toMatchObject({
			campaign_percent: 20,
			now: {sale_try_minor: 480},
		});

		const removed = await createBuilder<ShopAdminResponse>(harness, admin.token)
			.post('/admin/shop/campaigns/remove')
			.body({skus: ['premium:1']})
			.execute();
		expect(removed.prices.find((price) => price.sku === 'premium:1')).toMatchObject({
			campaign_percent: null,
			campaign_ends_at: null,
			now: {campaign_percent: null, sale_try_minor: 600},
		});
		expect(removed.prices.find((price) => price.sku === `cosmetic:${item.id}`)?.campaign_percent).toBe(20);
	});

	it('records old and new values of every changed setting', async () => {
		await patchSettings({premium_sales_open: true, premium_discount_percent: 30, item_sales_open: false});

		expect(await auditMetadata('update_shop_settings')).toEqual([
			{
				premium_sales_open_old: 'false',
				premium_sales_open_new: 'true',
				premium_discount_percent_old: '0',
				premium_discount_percent_new: '30',
			},
		]);
	});

	it('shows the payment provider budget health from its counters', async () => {
		const hour = Math.floor(Date.now() / 3_600_000);
		await getKVClient().set(`shop:busy:${hour}`, '2');
		await getKVClient().set(`shop:busy:${hour - 1}`, '3');
		await getKVClient().set(`shop:busy:${hour - 2}`, '100');
		await getKVClient().set('shop:checks:lag', '960');
		await getKVClient().set('payriff:backoff', '1');

		expect((await view()).health).toEqual({
			busy_refusals_last_hour: 5,
			reconcile_lag_seconds: 960,
			provider_backing_off: true,
		});
	});

	describe('Visionary', () => {
		it('applies a campaign to Visionary', async () => {
			await putPrices([{sku: 'visionary', base_try_minor: 29_900}]);

			const applied = await campaign({skus: ['visionary'], percent: 20, ends_at: null});

			expect(applied.prices.find((price) => price.sku === 'visionary')).toMatchObject({
				campaign_percent: 20,
				now: {campaign_percent: 20, sale_try_minor: 23_920, premium_try_minor: null},
			});
		});

		it('takes only owned, unpriced items as Visionary rewards, at most 10', async () => {
			const reward = await createShopItem(harness, admin, 'owned', 'Reward');
			const priced = await createShopItem(harness, admin, 'owned', 'Priced');
			const premium = await createShopItem(harness, admin, 'premium', 'Premium');
			await putPrices([{sku: `cosmetic:${priced.id}`, base_try_minor: 500}]);

			await patchSettings({visionary_reward_item_ids: [priced.id]}, 400);
			await patchSettings({visionary_reward_item_ids: [premium.id]}, 400);
			await patchSettings({visionary_reward_item_ids: ['1490000000000000001']}, 400);
			await patchSettings({visionary_reward_item_ids: Array.from({length: 11}, () => reward.id)}, 400);

			const settings = await patchSettings({visionary_reward_item_ids: [reward.id, reward.id]});
			expect(settings.visionary_reward_item_ids).toEqual([reward.id]);
			expect((await patchSettings({visionary_reward_item_ids: []})).visionary_reward_item_ids).toEqual([]);
		});

		it('refuses a price for a Visionary reward item', async () => {
			const reward = await createShopItem(harness, admin, 'owned', 'Reward');
			await patchSettings({visionary_reward_item_ids: [reward.id]});

			await putPrices([{sku: `cosmetic:${reward.id}`, base_try_minor: 500}], 400);
		});

		it('records old and new Visionary settings', async () => {
			const first = await createShopItem(harness, admin, 'owned', 'First');
			const second = await createShopItem(harness, admin, 'owned', 'Second');
			await patchSettings({visionary_reward_item_ids: [first.id]});
			await patchSettings({visionary_on_sale: true, visionary_reward_item_ids: [first.id, second.id]});

			expect((await auditMetadata('update_shop_settings')).find((entry) => 'visionary_on_sale_new' in entry)).toEqual({
				visionary_on_sale_old: 'false',
				visionary_on_sale_new: 'true',
				visionary_reward_item_ids_old: first.id,
				visionary_reward_item_ids_new: `${first.id},${second.id}`,
			});
		});
	});
});
