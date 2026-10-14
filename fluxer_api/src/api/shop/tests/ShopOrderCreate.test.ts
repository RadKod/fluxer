// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {SHOP_PRICE_CATALOG, type ShopOrderRow} from '@app/api/database/types/ShopTypes';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {
	getCosmeticService,
	getInstanceConfigRepository,
	getPayriffRateLimiter,
	getPremiumLedgerService,
	getShopOrderRepository,
	getShopPriceRepository,
	getVisionaryService,
	getVisionarySlotRepository,
} from '@app/api/middleware/ServiceSingletons';
import {hashCallbackToken} from '@app/api/payriff/PayriffCallbackToken';
import {PayriffClient} from '@app/api/payriff/PayriffClient';
import {PayriffRateLimiter} from '@app/api/payriff/PayriffRateLimiter';
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
		await getVisionarySlotRepository().shrinkVisionarySlots(0);
		await getVisionaryService().setTotal(total);
	}

	it('keeps quote, stored order and Payriff AZN identical when automatic and override TL rates change', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 199});
		const repository = getInstanceConfigRepository();
		for (const [automatic, override] of [
			[40_000, null],
			[50_000, 60_000],
			[null, null],
		]) {
			await repository.updateShopConfig(() => ({
				try_to_azn_rate_micro: automatic,
				try_to_azn_rate_override_micro: override,
				try_rate_date: '2026-10-02',
			}));
			const buyer = await createTestAccount(harness);
			const quote = await createBuilder<{amount_azn_minor: number}>(harness, buyer.token)
				.get('/shop/quote?sku=premium:1')
				.execute();
			const created = await createOrder('premium:1', buyer);
			expect(quote.amount_azn_minor).toBe(338);
			expect(created.amount_azn_minor).toBe(338);
			expect((await storedOrder(created.id)).amount_minor).toBe(338);
		}
		for (const call of payriffCreates()) expect(call.body).toMatchObject({amount: 3.38, currency: 'AZN'});
	});

	it('freezes the direct TRY quote and keeps it after settings change', async () => {
		await openShop(harness, admin);
		await getInstanceConfigRepository().updateShopConfig(() => ({try_to_azn_rate_override_micro: 50_000}));
		await setPrices(harness, admin, {'premium:1': 199});
		const created = await createOrder('premium:1');
		expect(created).toMatchObject({display_currency: 'TRY', display_amount_minor: 6760, display_rate_micro: 50_000});
		expect(await storedOrder(created.id)).toMatchObject({
			display_currency: 'TRY',
			display_amount_minor: 6760n,
			display_rate_micro: 50_000,
		});
		expect(payriffCreates()[0]!.body).toMatchObject({
			description: `sanalyer Plus · 1 ay — mağazadaki fiyat 67,6 TL. Bu ödeme Azerbaycan manatı ile alınır: 3,38 AZN. Sipariş #${created.id}`,
		});
		await getInstanceConfigRepository().updateShopConfig(() => ({try_to_azn_rate_override_micro: 60_000}));
		expect(
			await createBuilder<ShopOrderResponse>(harness, user.token).get(`/shop/orders/${created.id}`).execute(),
		).toEqual(created);
	});

	it('freezes the largest allowed TRY amount without overflowing Cassandra int', async () => {
		await openShop(harness, admin, {usd_to_azn_rate_micro: 3_000_000});
		await getInstanceConfigRepository().updateShopConfig(() => ({try_to_azn_rate_override_micro: 1000}));
		await setPrices(harness, admin, {'premium:1': 10_000_000});
		const created = await createOrder('premium:1');
		expect(created).toMatchObject({
			display_currency: 'TRY',
			display_amount_minor: 30_000_000_000,
			display_rate_micro: 1000,
		});
		expect(await storedOrder(created.id)).toMatchObject({display_amount_minor: 30_000_000_000n});
	});

	it('freezes AZN when no current TRY rate exists', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 199});
		const created = await createOrder('premium:1');
		expect(created).toMatchObject({display_currency: 'AZN', display_amount_minor: 338, display_rate_micro: null});
		expect(payriffCreates()[0]!.body).toMatchObject({
			description: `sanalyer Plus · 1 ay — mağazadaki fiyat 3,38 AZN. Sipariş #${created.id}`,
		});
	});

	it.each([
		['2026-09-27', null, 'AZN', 338, null],
		['2026-09-28', null, 'TRY', 423, 800_000],
		['2026-09-27', 50_000, 'TRY', 6760, 50_000],
	] as const)(
		'uses the catalog rate validity and half-up rule (date %s, override %s)',
		async (date, override, currency, amount, rate) => {
			atTime(Date.parse('2026-10-08T12:00:00Z'));
			await openShop(harness, admin);
			await getInstanceConfigRepository().updateShopConfig(() => ({
				try_to_azn_rate_micro: 800_000,
				try_rate_date: date,
				try_to_azn_rate_override_micro: override,
			}));
			await setPrices(harness, admin, {'premium:1': 199});
			expect(await createOrder('premium:1')).toMatchObject({
				amount_azn_minor: 338,
				display_currency: currency,
				display_amount_minor: amount,
				display_rate_micro: rate,
			});
		},
	);

	it.each([{display_currency: 'TRY' as const}, {display_amount_minor: 339n}, {display_rate_micro: 50_000}])(
		'rejects reuse when a stored display quote component differs: %o',
		async (patch) => {
			await openShop(harness, admin);
			await setPrices(harness, admin, {'premium:1': 199});
			const first = await createOrder('premium:1');
			await patchStored(first.id, patch);
			expect((await createOrder('premium:1')).id).not.toBe(first.id);
		},
	);

	it('checks the direct price before reuse when the cached price still matches the old order', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const first = await createOrder('premium:1');
		await getShopPriceRepository().putPrices([
			{
				catalog: SHOP_PRICE_CATALOG,
				sku: 'premium:1',
				base_usd_cents: 700,
				campaign_percent: null,
				campaign_ends_at: null,
				updated_at: new Date(),
			},
		]);
		const direct = vi.spyOn(ShopPriceRepository.prototype, 'getPrice');
		const second = await createOrder('premium:1');
		expect(second.id).not.toBe(first.id);
		expect(second.final_usd_cents).toBe(700);
		expect(direct).toHaveBeenCalledTimes(1);
	});

	it('does not reuse legacy orders with no frozen display quote', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 199});
		const first = await createOrder('premium:1');
		await patchStored(first.id, {display_currency: null, display_amount_minor: null, display_rate_micro: null});
		expect((await createOrder('premium:1')).id).not.toBe(first.id);
	});

	it('checks the direct TRY rate before reuse even when AZN and rounded TRY amount match', async () => {
		await openShop(harness, admin);
		await getInstanceConfigRepository().updateShopConfig(() => ({try_to_azn_rate_override_micro: 50_000}));
		await setPrices(harness, admin, {'premium:1': 199});
		const first = await createOrder('premium:1');
		const repository = getInstanceConfigRepository();
		const config = await repository.readStoredShopConfig();
		vi.spyOn(repository, 'getShopConfig').mockResolvedValue(config);
		vi.spyOn(repository, 'readStoredShopConfig').mockResolvedValue({...config, try_to_azn_rate_override_micro: 50_001});
		const second = await createOrder('premium:1');
		expect(second.id).not.toBe(first.id);
		expect(second).toMatchObject({amount_azn_minor: 338, display_amount_minor: 6760, display_rate_micro: 50_001});
	});

	it('reuses identical quotes without consuming a depleted provider budget', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 199});
		const first = await createOrder('premium:1');
		const budget = vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire').mockResolvedValue(false);
		expect((await createOrder('premium:1')).id).toBe(first.id);
		expect(budget).not.toHaveBeenCalled();
	});

	it('cached checkout eligibility does not read TL fields', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 199});
		const repository = getInstanceConfigRepository();
		const config = await repository.readStoredShopConfig();
		for (const key of [
			'try_to_azn_rate_micro',
			'try_rate_date',
			'try_rate_fetched_at',
			'try_to_azn_rate_override_micro',
			'try_rate_override_at',
		]) {
			Object.defineProperty(config, key, {
				get: () => {
					throw new Error(`Payment read ${key}`);
				},
			});
		}
		vi.spyOn(repository, 'getShopConfig').mockResolvedValue(config);
		expect((await createOrder('premium:1')).amount_azn_minor).toBe(338);
	});

	it('returns the exact stored order micro rate after the shop rate changes', async () => {
		await openShop(harness, admin, {usd_to_azn_rate_micro: 1_700_051});
		await setPrices(harness, admin, {'premium:1': 199});
		const created = await createOrder('premium:1');
		expect(created).toMatchObject({usd_to_azn_rate_micro: 1_700_051, amount_azn_minor: 338});
		await getInstanceConfigRepository().updateShopConfig(() => ({usd_to_azn_rate_micro: 1_800_001}));
		const retrieved = await createBuilder<ShopOrderResponse>(harness, user.token)
			.get(`/shop/orders/${created.id}`)
			.execute();
		expect(retrieved).toMatchObject({usd_to_azn_rate_micro: 1_700_051, amount_azn_minor: 338});
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
			base_usd_cents: 500,
			campaign_percent: 20,
			premium_percent: 30,
			final_usd_cents: 280,
			amount_azn_minor: 476,
			usd_to_azn_rate: '1.7000',
			currency: 'AZN',
			payment_url: 'https://pay.payriff.test/r/payriff-order-1?type=direct',
		});
		const row = await storedOrder(created.id);
		expect(row).toMatchObject({
			user_id: createUserID(BigInt(user.userId)),
			item_id: BigInt(item.id),
			premium_months: null,
			base_usd_cents: 500,
			campaign_percent: 20,
			premium_percent: 30,
			final_usd_cents: 280,
			rate_micro: 1_700_000,
			amount_minor: 476,
			currency: 'AZN',
			provider: 'payriff',
			provider_order_id: 'payriff-order-1',
			status: 'pending',
			check_count: 0,
		});
		expect(row.next_check_at?.getTime()).toBe(row.created_at.getTime() + 2 * MINUTE);
		const calls = payriffCreates();
		expect(calls).toHaveLength(1);
		const body = calls[0]!.body as {amount: number; description: string; callbackUrl: string; currency: string};
		expect(body.amount).toBe(4.76);
		expect(body.currency).toBe('AZN');
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

		expect(await createOrder(`cosmetic:${item.id}`)).toMatchObject({premium_percent: 0, final_usd_cents: 400});
	});

	it('ignores any price the client sends', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});

		const created = await order('premium:1', user, {final_usd_cents: 1, amount_azn_minor: 1}).expect(200).execute();

		expect(created).toMatchObject({final_usd_cents: 500, amount_azn_minor: 850});
		expect((payriffCreates()[0]!.body as {amount: number}).amount).toBe(8.5);
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
				base_usd_cents: 700,
				campaign_percent: null,
				campaign_ends_at: null,
				updated_at: new Date(),
			},
		]);
		const tryAcquire = vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire');
		const getPrice = vi.spyOn(ShopPriceRepository.prototype, 'getPrice');

		const created = await createOrder('premium:1');

		expect(created.final_usd_cents).toBe(700);
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
		expect(second.final_usd_cents).toBe(600);
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
		expect(created).toMatchObject({sku: 'visionary', base_usd_cents: 5000, premium_percent: 0});
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
