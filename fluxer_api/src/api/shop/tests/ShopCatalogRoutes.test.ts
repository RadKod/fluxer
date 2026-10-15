// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getBadgeRepository,
	getCosmeticRepository,
	getCosmeticService,
	getInstanceConfigRepository,
	getPremiumLedgerRepository,
	getShopPriceRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {ShopCatalogService, type VisionaryStockReader} from '@app/api/shop/ShopCatalogService';
import {
	createShopAdmin,
	createShopItem,
	openShop,
	saveShopEnvironment,
	setPremiumMode,
	setPrices,
} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {ShopCatalogResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

describe('shop catalog', () => {
	let harness: ApiTestHarness;
	let restoreEnvironment: () => void;
	let admin: TestAccount;
	let user: TestAccount;

	beforeAll(async () => {
		restoreEnvironment = saveShopEnvironment();
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		admin = await createShopAdmin(harness);
		user = await createTestAccount(harness);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	function getCatalog(account = user) {
		return createBuilder<ShopCatalogResponse>(harness, account.token).get('/shop/catalog').execute();
	}

	it('shows priced owned items and premium items and hides free, unpriced and off-sale ones', async () => {
		await openShop(harness, admin);
		const priced = await createShopItem(harness, admin, 'owned', 'Priced');
		const unpriced = await createShopItem(harness, admin, 'owned', 'Unpriced');
		const offSale = await createShopItem(harness, admin, 'owned', 'Off sale');
		const premium = await createShopItem(harness, admin, 'premium', 'Premium');
		await createShopItem(harness, admin, 'free', 'Free');
		await setPrices(harness, admin, {[`cosmetic:${priced.id}`]: 500, [`cosmetic:${offSale.id}`]: 500});
		await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${offSale.id}`).expect(204).execute();

		const catalog = await getCatalog();

		expect(catalog.items.map(({item}) => item.id).sort()).toEqual([priced.id, premium.id].sort());
		expect(catalog.items.find(({item}) => item.id === priced.id)?.price).toEqual({
			base_try_minor: 500,
			campaign_percent: null,
			campaign_ends_at: null,
			sale_try_minor: 500,
			premium_try_minor: null,
		});
		expect(catalog.items.find(({item}) => item.id === premium.id)?.price).toBeNull();
		expect(catalog.items.some(({item}) => item.id === unpriced.id)).toBe(false);
		expect(catalog.settings).toEqual({
			premium_sales_open: true,
			item_sales_open: true,
			premium_discount_percent: 0,
		});
		expect(catalog.viewer).toEqual({premium_discount: false});
	});

	it('lists priced packages in 1, 3, 12 order', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:12': 4800, 'premium:1': 500, 'premium:3': 1300});

		const {packages} = await getCatalog();

		expect(packages.map(({sku, months}) => [sku, months])).toEqual([
			['premium:1', 1],
			['premium:3', 3],
			['premium:12', 12],
		]);
		expect(packages[2]!.price).toEqual({
			base_try_minor: 4800,
			campaign_percent: null,
			campaign_ends_at: null,
			sale_try_minor: 4800,
			premium_try_minor: null,
		});
	});

	it('reports both sales closed while Payriff is not configured', async () => {
		await openShop(harness, admin);
		Config.payriff.enabled = false;
		try {
			const {settings} = await getCatalog();
			expect(settings.premium_sales_open).toBe(false);
			expect(settings.item_sales_open).toBe(false);
		} finally {
			Config.payriff.enabled = true;
		}
	});

	it('answers FEATURE_NOT_AVAILABLE_SELF_HOSTED outside mirror mode', async () => {
		await openShop(harness, admin);
		await setPremiumMode(harness, admin, 'everyone');

		await createBuilder(harness, user.token)
			.get('/shop/catalog')
			.expect(403, APIErrorCodes.FEATURE_NOT_AVAILABLE_SELF_HOSTED)
			.execute();
		await createBuilder(harness, user.token)
			.get('/shop/quote?sku=premium:1')
			.expect(403, APIErrorCodes.FEATURE_NOT_AVAILABLE_SELF_HOSTED)
			.execute();
	});

	it('gives items a premium price only when the premium discount is above 0', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		await openShop(harness, admin);
		const item = await createShopItem(harness, admin, 'owned');
		await setPrices(harness, admin, {[`cosmetic:${item.id}`]: 500, 'premium:1': 500});
		const before = await getCatalog();
		expect(before.items[0]!.price!.premium_try_minor).toBeNull();

		await createBuilder(harness, admin.token)
			.patch('/admin/shop/settings')
			.body({premium_discount_percent: 30})
			.execute();
		vi.setSystemTime(Date.now() + 61_000);
		const after = await getCatalog();

		expect(after.items[0]!.price!.premium_try_minor).toBe(350);
		expect(after.packages[0]!.price.premium_try_minor).toBeNull();
		expect(after.settings.premium_discount_percent).toBe(30);
	});

	it('shows no Visionary block without a price', async () => {
		await openShop(harness, admin, {visionary_on_sale: true});

		expect((await getCatalog()).visionary).toBeNull();
	});

	describe('with a Visionary stock reader', () => {
		function serviceWithStock(
			stock: {total: number; remaining: number},
			visionaryStock: VisionaryStockReader = {getStock: async () => stock},
		) {
			return new ShopCatalogService({
				priceRepository: getShopPriceRepository(),
				badgeRepository: getBadgeRepository(),
				cosmeticService: getCosmeticService(),
				cosmeticRepository: getCosmeticRepository(),
				instanceConfigRepository: getInstanceConfigRepository(),
				premiumLedgerRepository: getPremiumLedgerRepository(),
				kvClient: getKVClient(),
				visionaryStock,
				snowflakeService: getSnowflakeService(),
			});
		}

		async function viewer() {
			return (await getUserRepository().findUnique(createUserID(BigInt(user.userId))))!;
		}

		it('shows the Visionary block with stock from the reader and keeps it visible when sold out', async () => {
			await openShop(harness, admin, {visionary_on_sale: true});
			await setPrices(harness, admin, {visionary: 29_900});

			const catalog = await serviceWithStock({total: 100, remaining: 0}).getCatalog(await viewer());

			expect(catalog.visionary).toEqual({
				sku: 'visionary',
				price: {
					base_try_minor: 29_900,
					campaign_percent: null,
					campaign_ends_at: null,
					sale_try_minor: 29_900,
					premium_try_minor: null,
				},
				total: 100,
				remaining: 0,
				visible: true,
			});
		});

		it('API processes share one Visionary stock read a minute', async () => {
			vi.useFakeTimers({toFake: ['Date']});
			await openShop(harness, admin, {visionary_on_sale: true});
			await setPrices(harness, admin, {visionary: 29_900});
			const stock = {total: 100, remaining: 40};
			const getStock = vi.fn(async () => stock);
			const processes = [serviceWithStock(stock, {getStock}), serviceWithStock(stock, {getStock})];

			for (const apiProcess of processes) {
				expect((await apiProcess.getCatalog(await viewer())).visionary).toMatchObject({total: 100, remaining: 40});
			}
			expect(getStock).toHaveBeenCalledTimes(1);

			vi.setSystemTime(Date.now() + 61_000);
			await processes[1]!.getCatalog(await viewer());
			expect(getStock).toHaveBeenCalledTimes(2);
		});

		it('shows Visionary as not visible while it is not on sale', async () => {
			await openShop(harness, admin, {visionary_on_sale: false});
			await setPrices(harness, admin, {visionary: 29_900});

			const catalog = await serviceWithStock({total: 100, remaining: 40}).getCatalog(await viewer());

			expect(catalog.visionary?.visible).toBe(false);
		});

		it('shows a Visionary campaign and never a member price', async () => {
			await openShop(harness, admin, {visionary_on_sale: true, premium_discount_percent: 30});
			await setPrices(harness, admin, {visionary: 29_900});
			await createBuilder(harness, admin.token)
				.post('/admin/shop/campaigns')
				.body({skus: ['visionary'], percent: 20, ends_at: '2099-01-01T00:00:00.000Z'})
				.execute();

			const catalog = await serviceWithStock({total: 100, remaining: 40}).getCatalog(await viewer());

			expect(catalog.visionary?.price).toEqual({
				base_try_minor: 29_900,
				campaign_percent: 20,
				campaign_ends_at: '2099-01-01T00:00:00.000Z',
				sale_try_minor: 23_920,
				premium_try_minor: null,
			});
		});
	});
});
