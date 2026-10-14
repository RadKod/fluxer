// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {InstanceConfigurationRow} from '@app/api/database/types/InstanceConfigTypes';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
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

	function putPrices(prices: Array<{sku: string; base_usd_cents: number | null}>, status = 200) {
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
			createBuilder(harness, cosmeticsAdmin.token).post('/admin/shop/settings/refresh-try-rate'),
			createBuilder(harness, cosmeticsAdmin.token).patch('/admin/shop/settings').body({item_sales_open: true}),
			createBuilder(harness, cosmeticsAdmin.token)
				.put('/admin/shop/prices')
				.body({prices: [{sku: 'premium:1', base_usd_cents: 500}]}),
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

	it('stores and audits override changes and clearing returns to automatic', async () => {
		expect(await patchSettings({try_to_azn_rate_override: '0.040123'})).toMatchObject({
			try_to_azn_rate_override_micro: 40_123,
			try_rate_override_at: expect.any(String),
		});
		expect(await auditMetadata('update_shop_settings')).toContainEqual(
			expect.objectContaining({try_to_azn_rate_override_micro_new: '40123'}),
		);
		expect(await patchSettings({try_to_azn_rate_override: null})).toMatchObject({
			try_to_azn_rate_override_micro: null,
			try_rate_override_at: null,
		});
		await patchSettings({try_to_azn_rate_override: '1.01'}, 400);
	});

	it('queues and audits a manual CBAR refresh', async () => {
		const addJob = vi.spyOn(getWorkerService(), 'addJob');
		await createBuilder(harness, admin.token).post('/admin/shop/settings/refresh-try-rate').expect(204).execute();
		expect(await auditMetadata('refresh_shop_try_rate')).toHaveLength(1);
		expect(addJob).toHaveBeenCalledWith('syncShopTryRate', {}, expect.objectContaining({requireLedger: true}));
		addJob.mockRestore();
	});
	it('preserves the override timestamp and audit fields on an unrelated settings save', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		const initial = await patchSettings({try_to_azn_rate_override: '0.040123'});
		vi.setSystemTime(Date.now() + 1_000);
		const auditBefore = await auditMetadata('update_shop_settings');
		expect(await patchSettings({try_to_azn_rate_override: '0.040123'})).toEqual(initial);
		expect(await auditMetadata('update_shop_settings')).toEqual(auditBefore);
		const saved = await patchSettings({try_to_azn_rate_override: '0.040123', item_sales_open: true});
		expect(saved.try_rate_override_at).toBe(initial.try_rate_override_at);
		const changes = await auditMetadata('update_shop_settings');
		expect(changes).toContainEqual({item_sales_open_old: 'false', item_sales_open_new: 'true'});
		expect(changes.filter((change) => 'try_rate_override_at_new' in change)).toHaveLength(1);
		const changed = await patchSettings({try_to_azn_rate_override: '0.05'});
		expect(changed.try_rate_override_at).not.toBe(initial.try_rate_override_at);
		expect(await auditMetadata('update_shop_settings')).toContainEqual(
			expect.objectContaining({
				try_to_azn_rate_override_micro_old: '40123',
				try_to_azn_rate_override_micro_new: '50000',
			}),
		);
	});

	it('stores the settings under the shop_config key', async () => {
		const settings = await patchSettings({
			premium_sales_open: true,
			premium_discount_percent: 25,
			usd_to_azn_rate_micro: 1_705_000,
		});

		expect(settings).toEqual({
			try_to_azn_rate_micro: null,
			try_rate_date: null,
			try_rate_fetched_at: null,
			try_to_azn_rate_override_micro: null,
			try_rate_override_at: null,
			premium_sales_open: true,
			item_sales_open: false,
			premium_discount_percent: 25,
			usd_to_azn_rate_micro: 1_705_000,
			payriff_configured: true,
			visionary_on_sale: false,
			visionary_reward_item_ids: [],
		});
		const row = await fetchOne<InstanceConfigurationRow>(
			InstanceConfiguration.selectCql({where: InstanceConfiguration.where.eq('key'), limit: 1}),
			{key: 'shop_config'},
		);
		expect(JSON.parse(row!.value!)).toEqual({
			try_to_azn_rate_micro: null,
			try_rate_date: null,
			try_rate_fetched_at: null,
			try_to_azn_rate_override_micro: null,
			try_rate_override_at: null,
			premium_sales_open: true,
			item_sales_open: false,
			usd_to_azn_rate_micro: 1_705_000,
			premium_discount_percent: 25,
			visionary_on_sale: false,
			visionary_reward_item_ids: [],
		});
		expect((await view()).settings).toEqual(settings);
	});

	it('starts with both sales closed and reports Payriff as not configured without a key', async () => {
		const previous = Config.payriff.enabled;
		Config.payriff.enabled = false;
		try {
			expect((await view()).settings).toMatchObject({
				premium_sales_open: false,
				item_sales_open: false,
				usd_to_azn_rate_micro: 1_700_000,
				payriff_configured: false,
			});
		} finally {
			Config.payriff.enabled = previous;
		}
	});

	it('refuses a discount above 95, a rate outside 1–3 and a price that ends below 0.10 AZN', async () => {
		await patchSettings({premium_discount_percent: 96}, 400);
		await patchSettings({usd_to_azn_rate_micro: 999_999}, 400);
		await patchSettings({usd_to_azn_rate_micro: 3_000_001}, 400);
		await putPrices([{sku: 'premium:1', base_usd_cents: 5}], 400);
		await putPrices([{sku: 'premium:1', base_usd_cents: 0}], 400);

		await putPrices([{sku: 'premium:1', base_usd_cents: 6}]);
		expect((await view()).prices.map(({sku, base_usd_cents}) => [sku, base_usd_cents])).toEqual([['premium:1', 6]]);
		expect((await view()).settings.premium_discount_percent).toBe(0);
	});

	it('refuses a settings change that would push a priced item below 0.10 AZN', async () => {
		const item = await createShopItem(harness, admin, 'owned');
		await putPrices([
			{sku: `cosmetic:${item.id}`, base_usd_cents: 10},
			{sku: 'premium:1', base_usd_cents: 6},
		]);

		await patchSettings({premium_discount_percent: 50}, 400); // 10 → 5 cents → 8.5 → 9 qepik
		await patchSettings({usd_to_azn_rate_micro: 1_500_000}, 400); // 6 cents → 9 qepik
		await putPrices([{sku: `cosmetic:${item.id}`, base_usd_cents: 12}]);
		await patchSettings({premium_discount_percent: 50}); // 12 → 6 cents → 10.2 → 10 qepik

		expect((await view()).settings).toMatchObject({premium_discount_percent: 50, usd_to_azn_rate_micro: 1_700_000});
		await campaign({skus: [`cosmetic:${item.id}`], percent: 50, ends_at: null}, 400); // 12 → 6 → 3 cents
		await campaign({skus: ['premium:1'], percent: 10, ends_at: null}, 400); // 6 → 5 cents → 8.5 → 9 qepik
	});

	it('takes prices only for owned items and 1, 3, 12 month packages', async () => {
		const owned = await createShopItem(harness, admin, 'owned');
		const free = await createShopItem(harness, admin, 'free');
		const premium = await createShopItem(harness, admin, 'premium');

		await putPrices([{sku: `cosmetic:${free.id}`, base_usd_cents: 500}], 400);
		await putPrices([{sku: `cosmetic:${premium.id}`, base_usd_cents: 500}], 400);
		await putPrices([{sku: 'cosmetic:1490000000000000001', base_usd_cents: 500}], 400);
		await putPrices([{sku: 'premium:2', base_usd_cents: 500}], 400);

		const response = await putPrices([
			{sku: `cosmetic:${owned.id}`, base_usd_cents: 500},
			{sku: 'premium:1', base_usd_cents: 500},
			{sku: 'premium:3', base_usd_cents: 1300},
			{sku: 'premium:12', base_usd_cents: 4800},
		]);
		expect(response.prices.map(({sku}) => sku).sort()).toEqual(
			[`cosmetic:${owned.id}`, 'premium:1', 'premium:12', 'premium:3'].sort(),
		);
		expect(response.prices.find(({sku}) => sku === 'premium:3')).toEqual({
			sku: 'premium:3',
			base_usd_cents: 1300,
			campaign_percent: null,
			campaign_ends_at: null,
			now: {
				base_usd_cents: 1300,
				campaign_percent: null,
				campaign_ends_at: null,
				sale_usd_cents: 1300,
				premium_usd_cents: null,
			},
		});

		const removed = await putPrices([{sku: 'premium:3', base_usd_cents: null}]);
		expect(removed.prices.map(({sku}) => sku)).not.toContain('premium:3');
	});

	it('applies a campaign to several products and removes it', async () => {
		const item = await createShopItem(harness, admin, 'owned');
		await putPrices([
			{sku: `cosmetic:${item.id}`, base_usd_cents: 500},
			{sku: 'premium:1', base_usd_cents: 500},
			{sku: 'premium:3', base_usd_cents: 1300},
		]);

		await campaign({skus: ['premium:12'], percent: 20, ends_at: null}, 400);
		await campaign({skus: ['premium:1'], percent: 20, ends_at: '2020-01-01T00:00:00.000Z'}, 400);
		const applied = await campaign({skus: [`cosmetic:${item.id}`, 'premium:1'], percent: 20, ends_at: FUTURE});
		const row = (sku: string) => applied.prices.find((price) => price.sku === sku)!;
		expect(row('premium:1')).toMatchObject({
			campaign_percent: 20,
			campaign_ends_at: FUTURE,
			now: {campaign_percent: 20, campaign_ends_at: FUTURE, sale_usd_cents: 400},
		});
		expect(row(`cosmetic:${item.id}`).now.sale_usd_cents).toBe(400);
		expect(row('premium:3').campaign_percent).toBeNull();

		const repriced = await putPrices([{sku: 'premium:1', base_usd_cents: 600}]);
		expect(repriced.prices.find((price) => price.sku === 'premium:1')).toMatchObject({
			campaign_percent: 20,
			now: {sale_usd_cents: 480},
		});

		const removed = await createBuilder<ShopAdminResponse>(harness, admin.token)
			.post('/admin/shop/campaigns/remove')
			.body({skus: ['premium:1']})
			.execute();
		expect(removed.prices.find((price) => price.sku === 'premium:1')).toMatchObject({
			campaign_percent: null,
			campaign_ends_at: null,
			now: {campaign_percent: null, sale_usd_cents: 600},
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

	it('shows the Payriff budget health from its counters', async () => {
		const hour = Math.floor(Date.now() / 3_600_000);
		await getKVClient().set(`shop:busy:${hour}`, '2');
		await getKVClient().set(`shop:busy:${hour - 1}`, '3');
		await getKVClient().set(`shop:busy:${hour - 2}`, '100');
		await getKVClient().set('shop:checks:lag', '960');
		await getKVClient().set('payriff:backoff', '1');

		expect((await view()).health).toEqual({
			busy_refusals_last_hour: 5,
			reconcile_lag_seconds: 960,
			payriff_backing_off: true,
		});
	});

	describe('Visionary', () => {
		it('applies a campaign to Visionary', async () => {
			await putPrices([{sku: 'visionary', base_usd_cents: 29_900}]);

			const applied = await campaign({skus: ['visionary'], percent: 20, ends_at: null});

			expect(applied.prices.find((price) => price.sku === 'visionary')).toMatchObject({
				campaign_percent: 20,
				now: {campaign_percent: 20, sale_usd_cents: 23_920, premium_usd_cents: null},
			});
		});

		it('takes only owned, unpriced items as Visionary rewards, at most 10', async () => {
			const reward = await createShopItem(harness, admin, 'owned', 'Reward');
			const priced = await createShopItem(harness, admin, 'owned', 'Priced');
			const premium = await createShopItem(harness, admin, 'premium', 'Premium');
			await putPrices([{sku: `cosmetic:${priced.id}`, base_usd_cents: 500}]);

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

			await putPrices([{sku: `cosmetic:${reward.id}`, base_usd_cents: 500}], 400);
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
