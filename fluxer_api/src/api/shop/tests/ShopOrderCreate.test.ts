// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {SHOP_PRICE_CATALOG, type ShopOrderRow} from '@app/api/database/types/ShopTypes';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {
	getCosmeticService,
	getPayriffRateLimiter,
	getPremiumLedgerService,
	getShopOrderRepository,
	getShopPriceRepository,
	getVisionaryService,
} from '@app/api/middleware/ServiceSingletons';
import {hashCallbackToken} from '@app/api/payriff/PayriffCallbackToken';
import {PayriffClient} from '@app/api/payriff/PayriffClient';
import {PayriffRateLimiter} from '@app/api/payriff/PayriffRateLimiter';
import {clearVisionarySlots} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {VisionaryService} from '@app/api/premium/visionary/VisionaryService';
import {ShopOrderRepository, shopOrderCheckShard, shopOrderCheckSlot} from '@app/api/shop/ShopOrderRepository';
import {ShopPriceRepository} from '@app/api/shop/ShopPriceRepository';
import {
	createShopAdmin,
	createShopItem,
	openShop,
	saveShopEnvironment,
	setPrices,
} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {fakePayriffServer} from '@app/api/test/Setup';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {grantPremium} from '@app/api/user/tests/UserTestUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const RATE_LIMIT_TEST_HEADER = 'x-fluxer-test-enable-rate-limits';
const T0 = new Date('2026-10-15T12:00:00.000Z');
const MINUTE = 60_000;

describe('shop order creation', () => {
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

	function order(sku: string, account = user, body: Record<string, unknown> = {}) {
		return createBuilder<ShopOrderResponse>(harness, account.token)
			.post('/shop/orders')
			.body({sku, ...body});
	}

	function createOrder(sku: string, account = user) {
		return order(sku, account).expect(200).execute();
	}

	async function storedOrder(id: string): Promise<ShopOrderRow> {
		return (await getShopOrderRepository().find(BigInt(id)))!;
	}

	function payriffCreates() {
		return fakePayriffServer.calls().filter((call) => call.operation === 'create');
	}

	async function checkRows(row: ShopOrderRow) {
		return getShopOrderRepository().listChecks(
			shopOrderCheckSlot(new Date(row.created_at.getTime() + 2 * MINUTE)),
			shopOrderCheckShard(row.order_id),
			100,
		);
	}

	async function patchStored(id: string, patch: Partial<ShopOrderRow>): Promise<void> {
		const row = await storedOrder(id);
		expect(await getShopOrderRepository().patch(row.order_id, patch, row.version)).toBe(true);
	}

	function atTime(at: number): void {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(at);
	}

	async function openVisionary(total: number): Promise<void> {
		await openShop(harness, admin, {visionary_on_sale: true});
		await setPrices(harness, admin, {visionary: 5000});
		await clearVisionarySlots();
		await getVisionaryService().setTotal(total);
	}

	// sanalyer: one currency end to end; the quote, the order, the stored row and the provider request agree in TRY.
	it('keeps the quote, the order, the stored row and the provider amount identical in Turkish lira', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 14_999});
		const quote = await createBuilder<{final_try_minor: number; currency: string}>(harness, user.token)
			.get('/shop/quote?sku=premium:1')
			.execute();
		const created = await createOrder('premium:1');
		expect(quote).toMatchObject({final_try_minor: 14_999, currency: 'TRY'});
		expect(created).toMatchObject({final_try_minor: 14_999, currency: 'TRY'});
		expect(await storedOrder(created.id)).toMatchObject({amount_minor: 14_999, currency: 'TRY'});
		expect(payriffCreates()[0]!.body).toMatchObject({
			amount: 149.99,
			currency: 'TRY',
			description: `sanalyer Plus · 1 ay — ₺149,99. Sipariş #${created.id}`,
		});
	});

	it('keeps the stored order amount after the price changes', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 19_900});
		const created = await createOrder('premium:1');
		await setPrices(harness, admin, {'premium:1': 24_900});
		expect(
			await createBuilder<ShopOrderResponse>(harness, user.token).get(`/shop/orders/${created.id}`).execute(),
		).toEqual(created);
	});

	it('checks the direct price before reuse when the cached price still matches the old order', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const first = await createOrder('premium:1');
		await getShopPriceRepository().putPrices([
			{
				catalog: SHOP_PRICE_CATALOG,
				sku: 'premium:1',
				base_try_minor: 700,
				campaign_percent: null,
				campaign_ends_at: null,
				updated_at: new Date(),
			},
		]);
		const direct = vi.spyOn(ShopPriceRepository.prototype, 'getPrice');
		const second = await createOrder('premium:1');
		expect(second.id).not.toBe(first.id);
		expect(second.final_try_minor).toBe(700);
		expect(direct).toHaveBeenCalledTimes(1);
	});

	it('reuses identical quotes without consuming a depleted provider budget', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 199});
		const first = await createOrder('premium:1');
		const budget = vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire').mockResolvedValue(false);
		expect((await createOrder('premium:1')).id).toBe(first.id);
		expect(budget).not.toHaveBeenCalled();
	});

	it('writes every price component onto the order and calls Payriff once', async () => {
		await openShop(harness, admin, {premium_discount_percent: 30});
		const item = await createShopItem(harness, admin, 'owned');
		const sku = `cosmetic:${item.id}`;
		await setPrices(harness, admin, {[sku]: 500});
		await createBuilder(harness, admin.token)
			.post('/admin/shop/campaigns')
			.body({skus: [sku], percent: 20, ends_at: null})
			.execute();
		await grantPremium(harness, user.userId, UserPremiumTypes.SUBSCRIPTION);

		const created = await createOrder(sku);

		expect(created).toMatchObject({
			sku,
			status: 'pending',
			failure_reason: null,
			base_try_minor: 500,
			campaign_percent: 20,
			premium_percent: 30,
			final_try_minor: 280,
			currency: 'TRY',
			payment_url: 'https://pay.payriff.test/r/payriff-order-1?type=direct',
		});
		const row = await storedOrder(created.id);
		expect(row).toMatchObject({
			user_id: createUserID(BigInt(user.userId)),
			item_id: BigInt(item.id),
			premium_months: null,
			base_try_minor: 500,
			campaign_percent: 20,
			premium_percent: 30,
			amount_minor: 280,
			currency: 'TRY',
			provider: 'payriff',
			provider_order_id: 'payriff-order-1',
			status: 'pending',
			check_count: 0,
		});
		expect(row.next_check_at?.getTime()).toBe(row.created_at.getTime() + 2 * MINUTE);
		const calls = payriffCreates();
		expect(calls).toHaveLength(1);
		const body = calls[0]!.body as {amount: number; description: string; callbackUrl: string; currency: string};
		expect(body.amount).toBe(2.8);
		expect(body.currency).toBe('TRY');
		expect(body.description.endsWith(`Sipariş #${created.id}`)).toBe(true);
		const prefix = `/v1/payriff/callback/${created.id}/`;
		expect(body.callbackUrl).toContain(prefix);
		const token = body.callbackUrl.slice(body.callbackUrl.indexOf(prefix) + prefix.length);
		expect(row.callback_token_hash).toBe(hashCallbackToken(token));
		expect(Object.values(row).map(String)).not.toContain(token);
		const byUser = await getShopOrderRepository().listForUser(createUserID(BigInt(user.userId)), 10);
		expect(byUser.map((entry) => entry.order_id)).toEqual([row.order_id]);
		expect((await checkRows(row)).map((check) => check.order_id)).toEqual([row.order_id]);
	});

	it('a trial account pays the full item price', async () => {
		await openShop(harness, admin, {premium_discount_percent: 30});
		const item = await createShopItem(harness, admin, 'owned');
		await setPrices(harness, admin, {[`cosmetic:${item.id}`]: 400});
		await getPremiumLedgerService().grant({
			userId: createUserID(BigInt(user.userId)),
			grantKey: 'trial',
			duration: {unit: 'days', quantity: 7},
			source: 'trial',
		});

		expect(await createOrder(`cosmetic:${item.id}`)).toMatchObject({premium_percent: 0, final_try_minor: 400});
	});

	it('ignores any price the client sends', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});

		const created = await order('premium:1', user, {final_try_minor: 1, amount_minor: 1}).expect(200).execute();

		expect(created).toMatchObject({final_try_minor: 500});
		expect((payriffCreates()[0]!.body as {amount: number}).amount).toBe(5);
	});

	it('order creation reads the price row directly even when the catalog and the quote are cached', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		await createBuilder(harness, user.token).get('/shop/catalog').execute();
		await createBuilder(harness, user.token).get('/shop/quote?sku=premium:1').execute();
		await getShopPriceRepository().putPrices([
			{
				catalog: SHOP_PRICE_CATALOG,
				sku: 'premium:1',
				base_try_minor: 700,
				campaign_percent: null,
				campaign_ends_at: null,
				updated_at: new Date(),
			},
		]);
		const tryAcquire = vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire');
		const getPrice = vi.spyOn(ShopPriceRepository.prototype, 'getPrice');

		const created = await createOrder('premium:1');

		expect(created.final_try_minor).toBe(700);
		expect(getPrice).toHaveBeenCalledTimes(1);
		expect(tryAcquire).toHaveBeenCalledWith('create');
		expect(getPrice.mock.invocationCallOrder[0]).toBeLessThan(tryAcquire.mock.invocationCallOrder[0]!);
	});

	it('reuses the open order for the same product and price', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});

		const first = await createOrder('premium:1');
		const second = await createOrder('premium:1');

		expect(second.id).toBe(first.id);
		expect(second.payment_url).toBe(first.payment_url);
		expect(payriffCreates()).toHaveLength(1);
	});

	it('opens a new order when the price changed', async () => {
		atTime(T0.getTime());
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const first = await createOrder('premium:1');

		await setPrices(harness, admin, {'premium:1': 600});
		vi.setSystemTime(T0.getTime() + 6_000);
		const second = await createOrder('premium:1');

		expect(second.id).not.toBe(first.id);
		expect(second.final_try_minor).toBe(600);
		expect(payriffCreates()).toHaveLength(2);
	});

	it('does not reuse an order older than fifteen minutes or one Payriff declined', async () => {
		atTime(T0.getTime());
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const first = await createOrder('premium:1');

		vi.setSystemTime(T0.getTime() + 15 * MINUTE + 1_000);
		const second = await createOrder('premium:1');
		await patchStored(second.id, {provider_status: 'DECLINED'});
		const third = await createOrder('premium:1');

		expect(new Set([first.id, second.id, third.id]).size).toBe(3);
		expect(payriffCreates()).toHaveLength(3);
	});

	it('refuses a fourth open order', async () => {
		await openShop(harness, admin);
		const item = await createShopItem(harness, admin, 'owned');
		await setPrices(harness, admin, {
			'premium:1': 500,
			'premium:3': 1300,
			'premium:12': 4000,
			[`cosmetic:${item.id}`]: 300,
		});
		for (const sku of ['premium:1', 'premium:3', 'premium:12']) await createOrder(sku);

		await order(`cosmetic:${item.id}`).expect(409, APIErrorCodes.SHOP_TOO_MANY_OPEN_ORDERS).execute();

		expect(payriffCreates()).toHaveLength(3);
	});

	it('declined and older than fifteen minutes orders do not count', async () => {
		atTime(T0.getTime());
		await openShop(harness, admin);
		const item = await createShopItem(harness, admin, 'owned');
		await setPrices(harness, admin, {
			'premium:1': 500,
			'premium:3': 1300,
			'premium:12': 4000,
			[`cosmetic:${item.id}`]: 300,
		});
		await createOrder('premium:1');
		vi.setSystemTime(T0.getTime() + 16 * MINUTE);
		const declined = await createOrder('premium:3');
		await patchStored(declined.id, {provider_status: 'DECLINED'});
		await createOrder('premium:12');

		expect(await createOrder(`cosmetic:${item.id}`)).toMatchObject({status: 'pending'});
	});

	it('answers SHOP_BUSY without calling Payriff when the create budget is empty', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire').mockResolvedValue(false);
		const getPrice = vi.spyOn(ShopPriceRepository.prototype, 'getPrice');

		await order('premium:1').expect(503, APIErrorCodes.SHOP_BUSY).execute();

		expect(fakePayriffServer.calls()).toEqual([]);
		expect(getPrice).toHaveBeenCalledTimes(1);
		expect(await getKVClient().get(`shop:busy:${Math.floor(Date.now() / 3_600_000)}`)).toBe('1');
		expect(await getShopOrderRepository().listForUser(createUserID(BigInt(user.userId)), 10)).toEqual([]);
	});

	it('fails the order, clears its check and answers SHOP_BUSY when Payriff is down or rate limited', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500, 'premium:3': 1300});
		const userId = createUserID(BigInt(user.userId));

		fakePayriffServer.failNext('create', 'server_error');
		await order('premium:1').expect(503, APIErrorCodes.SHOP_BUSY).execute();
		const [entry] = await getShopOrderRepository().listForUser(userId, 10);
		const failed = (await getShopOrderRepository().find(entry!.order_id))!;
		expect(failed).toMatchObject({status: 'failed', failure_reason: 'provider_error', next_check_at: null});
		expect(await checkRows(failed)).toEqual([]);
		expect(await getPayriffRateLimiter().isBackingOff()).toBe(false);

		fakePayriffServer.failNext('create', 'rate_limit');
		await order('premium:3').expect(503, APIErrorCodes.SHOP_BUSY).execute();
		expect(await getPayriffRateLimiter().isBackingOff()).toBe(true);
		const rows = await getShopOrderRepository().listForUser(userId, 10);
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect((await getShopOrderRepository().find(row.order_id))?.status).toBe('failed');
		}
	});

	it('refuses an item the account owns and a closed sale', async () => {
		await openShop(harness, admin);
		const item = await createShopItem(harness, admin, 'owned');
		await setPrices(harness, admin, {[`cosmetic:${item.id}`]: 300, 'premium:1': 500});
		await getCosmeticService().grantOwned(createUserID(BigInt(user.userId)), BigInt(item.id), 'admin');
		await createBuilder(harness, admin.token).patch('/admin/shop/settings').body({premium_sales_open: false}).execute();

		await order(`cosmetic:${item.id}`).expect(409, APIErrorCodes.COSMETIC_ALREADY_OWNED).execute();
		await order('premium:1').expect(403, APIErrorCodes.SHOP_SALES_CLOSED).execute();

		expect(fakePayriffServer.calls()).toEqual([]);
	});

	it('limits order creation to 3 a minute and 20 a day', async () => {
		atTime(T0.getTime());
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const limited = () => order('premium:1').header(RATE_LIMIT_TEST_HEADER, 'true');

		for (let i = 0; i < 3; i++) await limited().expect(200).execute();
		await limited().expect(429, APIErrorCodes.RATE_LIMITED).execute();

		let made = 3;
		for (let minute = 1; made < 20; minute++) {
			vi.setSystemTime(T0.getTime() + minute * 61_000);
			for (let i = 0; i < 3 && made < 20; i++, made++) await limited().expect(200).execute();
		}
		vi.setSystemTime(Date.now() + 61_000);
		await limited().expect(429, APIErrorCodes.RATE_LIMITED).execute();
	});

	it('shows an order only to its owner', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const created = await createOrder('premium:1');
		const other = await createTestAccount(harness);

		const own = await createBuilder<ShopOrderResponse>(harness, user.token).get(`/shop/orders/${created.id}`).execute();
		expect(own).toEqual(created);
		await createBuilder(harness, other.token)
			.get(`/shop/orders/${created.id}`)
			.expect(404, APIErrorCodes.NOT_FOUND)
			.execute();
		await createBuilder(harness, user.token)
			.get('/shop/orders/1490000000000000001')
			.expect(404, APIErrorCodes.NOT_FOUND)
			.execute();
	});

	it('reading an order never calls Payriff', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const created = await createOrder('premium:1');
		fakePayriffServer.setStatus('payriff-order-1', 'APPROVED');

		for (let i = 0; i < 3; i++) {
			expect(
				(await createBuilder<ShopOrderResponse>(harness, user.token).get(`/shop/orders/${created.id}`).execute())
					.status,
			).toBe('pending');
		}

		expect(fakePayriffServer.calls()).toHaveLength(1);
	});

	it('the last Visionary slot goes to one of two buyers; the other gets SHOP_ITEM_UNAVAILABLE and Payriff is called once', async () => {
		await openVisionary(1);
		const second = await createTestAccount(harness);

		const responses = await Promise.all(
			[user, second].map((account) =>
				harness.requestJson({
					path: '/shop/orders',
					method: 'POST',
					body: {sku: 'visionary'},
					headers: {Authorization: account.token},
				}),
			),
		);

		expect(responses.map((response) => response.status).sort()).toEqual([200, 404]);
		const refused = responses.find((response) => response.status === 404)!;
		expect(((await refused.json()) as {code: string}).code).toBe(APIErrorCodes.SHOP_ITEM_UNAVAILABLE);
		expect(payriffCreates()).toHaveLength(1);
		expect(await getVisionaryService().getStock()).toMatchObject({total: 1, held: 1, remaining: 0});
	});

	it('a Visionary order holds a number before calling Payriff and a Payriff failure frees it', async () => {
		await openVisionary(2);
		const hold = vi.spyOn(VisionaryService.prototype, 'holdForOrder');
		const payriff = vi.spyOn(PayriffClient.prototype, 'createOrder');

		fakePayriffServer.failNext('create', 'server_error');
		await order('visionary').expect(503, APIErrorCodes.SHOP_BUSY).execute();
		expect(hold.mock.invocationCallOrder[0]).toBeLessThan(payriff.mock.invocationCallOrder[0]!);
		expect(await getVisionaryService().getStock()).toMatchObject({held: 0, remaining: 2});

		const created = await createOrder('visionary');
		expect(created).toMatchObject({sku: 'visionary', base_try_minor: 5000, premium_percent: 0});
		expect(await storedOrder(created.id)).toMatchObject({item_id: null, premium_months: null});
		expect(await getVisionaryService().getStock()).toMatchObject({held: 1, remaining: 1});
	});

	it('a Visionary order whose row cannot be written frees its number and never reaches Payriff', async () => {
		await openVisionary(1);
		const create = vi.spyOn(ShopOrderRepository.prototype, 'create');
		create.mockRejectedValueOnce(new Error('write timed out'));
		await order('visionary').expect(500).execute();
		create.mockResolvedValueOnce(false);
		await order('visionary').expect(500).execute();

		expect(await getVisionaryService().getStock()).toMatchObject({held: 0, remaining: 1});
		expect(fakePayriffServer.calls()).toEqual([]);
	});

	it('a Visionary order is refused when no number is free and never reaches Payriff', async () => {
		await openVisionary(0);

		await order('visionary').expect(404, APIErrorCodes.SHOP_ITEM_UNAVAILABLE).execute();

		expect(fakePayriffServer.calls()).toEqual([]);
		expect(await getShopOrderRepository().listForUser(createUserID(BigInt(user.userId)), 10)).toEqual([]);
	});
});
