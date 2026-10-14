// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import type {ShopOrderRow} from '@app/api/database/types/ShopTypes';
import {Logger} from '@app/api/Logger';
import {
	getCosmeticRepository,
	getShopOrderRepository,
	getUserRepository,
	getVisionaryService,
} from '@app/api/middleware/ServiceSingletons';
import {clearVisionarySlots} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {shopOrderCheckShard, shopOrderCheckSlot} from '@app/api/shop/ShopOrderRepository';
import {
	createShopAdmin,
	createShopItem,
	openShop,
	saveShopEnvironment,
	setPrices,
} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {fakePayriffServer} from '@app/api/test/Setup';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import verifyShopOrder from '@app/api/worker/tasks/VerifyShopOrder';
import {UserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {ShopAdminVisionaryResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};
const T0 = new Date('2026-10-15T12:00:00.000Z');
const MINUTE = 60_000;
const SECRET_MARKERS = ['payriff-test-secret-key', 'Authorization', 'callback', 'https://'];

describe('shop order verification and delivery', () => {
	let harness: ApiTestHarness;
	let restoreEnvironment: () => void;
	let admin: TestAccount;
	let user: TestAccount;
	let userId: UserID;

	beforeAll(async () => {
		restoreEnvironment = saveShopEnvironment();
		Config.instance.selfHosted = true;
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		admin = await createShopAdmin(harness);
		user = await createTestAccount(harness);
		userId = createUserID(BigInt(user.userId));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	function createOrder(sku: string, account = user) {
		return createBuilder<ShopOrderResponse>(harness, account.token)
			.post('/shop/orders')
			.body({sku})
			.expect(200)
			.execute();
	}

	async function stored(id: string): Promise<ShopOrderRow> {
		return (await getShopOrderRepository().find(BigInt(id)))!;
	}

	async function pay(id: string, paymentStatus = 'APPROVED'): Promise<void> {
		fakePayriffServer.setStatus((await stored(id)).provider_order_id!, paymentStatus);
	}

	function verify(id: string, trigger: 'callback' | 'reconcile' = 'callback') {
		return verifyShopOrder({orderId: id, trigger, budgeted: trigger === 'reconcile'}, HELPERS);
	}

	async function openCosmeticOrder() {
		await openShop(harness, admin);
		const item = await createShopItem(harness, admin, 'owned', 'Crown');
		await setPrices(harness, admin, {[`cosmetic:${item.id}`]: 300});
		return {item, order: await createOrder(`cosmetic:${item.id}`)};
	}

	function payriffGets() {
		return fakePayriffServer.calls().filter((call) => call.operation === 'get').length;
	}

	function warnings() {
		return vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
	}

	function expectNoSecrets(spy: ReturnType<typeof warnings>): void {
		const logged = JSON.stringify(spy.mock.calls, (_key, value) => (typeof value === 'bigint' ? `${value}` : value));
		for (const marker of SECRET_MARKERS) expect(logged).not.toContain(marker);
	}

	async function checkRowsOf(row: ShopOrderRow) {
		return getShopOrderRepository().listChecks(
			shopOrderCheckSlot(new Date(row.created_at.getTime() + 2 * MINUTE)),
			shopOrderCheckShard(row.order_id),
			100,
		);
	}

	async function openVisionary(total: number): Promise<void> {
		await openShop(harness, admin, {visionary_on_sale: true});
		await setPrices(harness, admin, {visionary: 5000});
		await clearVisionarySlots();
		await getVisionaryService().setTotal(total);
	}

	async function readUser(id: UserID = userId) {
		return (await getUserRepository().findUnique(id))!;
	}

	it('APPROVED with the right amount grants the item, wears it and marks the order granted', async () => {
		const {item, order} = await openCosmeticOrder();
		await pay(order.id);

		await verify(order.id);

		const row = await stored(order.id);
		expect(row).toMatchObject({status: 'granted', provider_status: 'APPROVED', next_check_at: null});
		expect(row.paid_at).toBeInstanceOf(Date);
		expect(row.granted_at).toBeInstanceOf(Date);
		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).toMatchObject({source: 'payriff'});
		expect((await readUser()).avatarDecorationId).toBe(BigInt(item.id));
		expect(await checkRowsOf(row)).toEqual([]);
		const view = await createBuilder<ShopOrderResponse>(harness, user.token).get(`/shop/orders/${order.id}`).execute();
		expect(view).toMatchObject({status: 'granted', payment_url: null});
	});

	it('PAID is accepted like APPROVED', async () => {
		const {order} = await openCosmeticOrder();
		await pay(order.id, 'PAID');

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
	});

	it('a callback claiming success is ignored while Payriff says CREATED', async () => {
		const {item, order} = await openCosmeticOrder();
		const url = (fakePayriffServer.calls()[0]!.body as {callbackUrl: string}).callbackUrl;
		const path = url.slice(url.indexOf('/v1/'));
		await harness.requestJson({path, method: 'POST', body: {paymentStatus: 'APPROVED', orderStatus: 'APPROVED'}});

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('pending');
		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).toBeNull();
	});

	it('an amount one kuruş off fails the order without delivery', async () => {
		const {item, order} = await openCosmeticOrder();
		const row = await stored(order.id);
		fakePayriffServer.setAmount(row.provider_order_id!, (row.amount_minor - 1) / 100);
		await pay(order.id);
		const warn = warnings();

		await verify(order.id);

		expect(await stored(order.id)).toMatchObject({
			status: 'failed',
			failure_reason: 'amount_mismatch',
			next_check_at: null,
		});
		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).toBeNull();
		expect(await checkRowsOf(row)).toEqual([]);
		expect(warn).toHaveBeenCalled();
		expectNoSecrets(warn);
	});

	it('a USD charge fails the order without delivery', async () => {
		const {item, order} = await openCosmeticOrder();
		const row = await stored(order.id);
		fakePayriffServer.setAmount(row.provider_order_id!, row.amount_minor / 100, 'USD');
		await pay(order.id);

		await verify(order.id);

		expect(await stored(order.id)).toMatchObject({status: 'failed', failure_reason: 'amount_mismatch'});
		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).toBeNull();
	});

	it('DECLINED keeps the order open; EXPIRED expires it; a late APPROVED on an expired order still delivers', async () => {
		const {item, order} = await openCosmeticOrder();

		await pay(order.id, 'DECLINED');
		await verify(order.id);
		expect(await stored(order.id)).toMatchObject({status: 'pending', provider_status: 'DECLINED'});

		await pay(order.id, 'EXPIRED');
		await verify(order.id);
		const expired = await stored(order.id);
		expect(expired).toMatchObject({status: 'expired', provider_status: 'EXPIRED', next_check_at: null});
		expect(await checkRowsOf(expired)).toEqual([]);

		await pay(order.id, 'APPROVED');
		await verify(order.id);
		expect((await stored(order.id)).status).toBe('granted');
		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).not.toBeNull();
	});

	it('a granted order is never delivered again and Payriff is not asked', async () => {
		const {order} = await openCosmeticOrder();
		await pay(order.id);
		await verify(order.id);
		const gets = payriffGets();
		const deliverOwned = vi.spyOn(CosmeticService.prototype, 'deliverOwned');

		await verify(order.id);
		await verify(order.id, 'reconcile');

		expect(payriffGets()).toBe(gets);
		expect(deliverOwned).not.toHaveBeenCalled();
		expect((await stored(order.id)).status).toBe('granted');
	});

	it('re-verifying a granted order after a take-back delivers nothing', async () => {
		const {item, order} = await openCosmeticOrder();
		await pay(order.id);
		await verify(order.id);
		await createBuilder(harness, admin.token)
			.delete(`/admin/users/${user.userId}/cosmetics/${item.id}`)
			.expect(200)
			.execute();
		const row = await stored(order.id);
		await getShopOrderRepository().patch(row.order_id, {status: 'paid', granted_at: null}, row.version);

		await verify(order.id);

		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).toBeNull();
		expect((await getCosmeticRepository().getGrant(userId, `payriff:${order.id}`))?.state).toBe('delivered');
		expect((await stored(order.id)).status).toBe('granted');
	});

	it('a paid item the account already owned is marked granted and logged for a refund', async () => {
		const {item, order} = await openCosmeticOrder();
		await createBuilder(harness, admin.token)
			.post(`/admin/users/${user.userId}/cosmetics/${item.id}`)
			.expect(200)
			.execute();
		await pay(order.id);
		const warn = warnings();

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(warn).toHaveBeenCalledWith(
			{orderId: order.id},
			'Shop order paid for an item the account already owned; refund by hand',
		);
		expectNoSecrets(warn);
	});

	it('a premium order grants with source payriff and makes the account a buyer', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:3': 1300});
		const order = await createOrder('premium:3');
		await pay(order.id);
		const before = Date.now();

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		const buyer = await readUser();
		expect(buyer.hasEverPurchased).toBe(true);
		expect(buyer.premiumType).not.toBe(UserPremiumTypes.NONE);
		const months = (buyer.premiumGiftExtensionEndsAt!.getTime() - before) / (24 * 3_600_000);
		expect(months).toBeGreaterThan(88);
		expect(months).toBeLessThan(93);
		const trial = await createBuilder<{eligible: boolean}>(harness, user.token).get('/premium/trial').execute();
		expect(trial.eligible).toBe(false);
	});

	it('a paid order of a deleted account fails without delivery', async () => {
		const {item, order} = await openCosmeticOrder();
		await pay(order.id);
		const account = await readUser();
		await getUserRepository().patchUpsert(userId, {flags: account.flags | UserFlags.DELETED}, account.toRow());
		const warn = warnings();

		await verify(order.id);

		expect(await stored(order.id)).toMatchObject({
			status: 'failed',
			failure_reason: 'account_deleted',
			next_check_at: null,
		});
		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).toBeNull();
		expect(warn).toHaveBeenCalledWith({orderId: order.id}, 'Shop order paid by a deleted account; refund by hand');
		expectNoSecrets(warn);
	});

	it('a paid order whose item is gone fails without delivery, leaves the schedule and is logged for a refund', async () => {
		const {item, order} = await openCosmeticOrder();
		await pay(order.id);
		const row = await stored(order.id);
		// There is no route that deletes an item; the row is simply gone.
		vi.spyOn(CosmeticRepository.prototype, 'getItem').mockResolvedValue(null);
		const warn = warnings();

		await verify(order.id);

		expect(await stored(order.id)).toMatchObject({
			status: 'failed',
			failure_reason: 'item_deleted',
			next_check_at: null,
		});
		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).toBeNull();
		expect(await checkRowsOf(row)).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			{orderId: order.id},
			'Shop order paid for an item that no longer exists; refund by hand',
		);
		expectNoSecrets(warn);
	});

	it('sales closed after payment still deliver', async () => {
		const {item, order} = await openCosmeticOrder();
		await createBuilder(harness, admin.token)
			.patch('/admin/shop/settings')
			.body({item_sales_open: false, premium_sales_open: false})
			.execute();
		await pay(order.id);

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await getCosmeticRepository().getOwned(userId, BigInt(item.id))).not.toBeNull();
	});

	it('a paid Visionary order gives lifetime premium and the held number', async () => {
		await openVisionary(3);
		await createOrder('visionary', await createTestAccount(harness));
		const order = await createOrder('visionary');
		await pay(order.id);

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		const buyer = await readUser();
		expect(buyer.premiumType).toBe(UserPremiumTypes.LIFETIME);
		expect(buyer.premiumLifetimeSequence).toBe(2);
		expect(buyer.hasEverPurchased).toBe(true);
	});

	it('a Visionary paid after its hold ended still gets a number', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(T0);
		await openVisionary(2);
		const late = await createOrder('visionary');
		const lateAgain = await createTestAccount(harness);
		const lateAgainOrder = await createOrder('visionary', lateAgain);

		vi.setSystemTime(T0.getTime() + 20 * MINUTE);
		const other = await createTestAccount(harness);
		const otherOrder = await createOrder('visionary', other);
		await pay(otherOrder.id);
		await verify(otherOrder.id);
		await pay(late.id);
		await verify(late.id);
		await pay(lateAgainOrder.id);
		await verify(lateAgainOrder.id);

		expect((await readUser(createUserID(BigInt(other.userId)))).premiumLifetimeSequence).toBe(1);
		expect((await readUser()).premiumLifetimeSequence).toBe(2);
		expect((await readUser(createUserID(BigInt(lateAgain.userId)))).premiumLifetimeSequence).toBe(3);
		for (const id of [otherOrder.id, late.id, lateAgainOrder.id]) expect((await stored(id)).status).toBe('granted');
		const stock = await createBuilder<ShopAdminVisionaryResponse>(harness, admin.token)
			.get('/admin/shop/visionary')
			.execute();
		expect(stock.over_cap_grants).toBe(1);
	});

	it('a Visionary order paid by an account that became a Visionary meanwhile gets no second number and is logged for a refund', async () => {
		await openVisionary(2);
		const order = await createOrder('visionary');
		const given = await getVisionaryService().takeSlot(userId, {orderId: null, allowOverCap: false});
		await getVisionaryService().applyLifetime(userId, given!.slot, false);
		await pay(order.id);
		const warn = warnings();

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect((await readUser()).premiumLifetimeSequence).toBe(given!.slot);
		expect(warn).toHaveBeenCalledWith(
			{orderId: order.id},
			'Visionary order paid by an account that already is a Visionary; refund by hand',
		);
		expect(await getVisionaryService().getStock()).toMatchObject({sold: 1, held: 0, remaining: 1});
	});

	it('a premium order paid by an account that became a Visionary meanwhile is logged for a refund', async () => {
		await openVisionary(1);
		await setPrices(harness, admin, {'premium:1': 500});
		const order = await createOrder('premium:1');
		const given = await getVisionaryService().takeSlot(userId, {orderId: null, allowOverCap: false});
		await getVisionaryService().applyLifetime(userId, given!.slot, false);
		await pay(order.id);
		const warn = warnings();

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('granted');
		expect((await readUser()).premiumType).toBe(UserPremiumTypes.LIFETIME);
		expect(warn).toHaveBeenCalledWith({orderId: order.id}, 'Premium order paid by a Visionary account; refund by hand');
		expectNoSecrets(warn);
	});

	it('an expired Visionary order frees its number', async () => {
		await openVisionary(1);
		const order = await createOrder('visionary');
		expect(await getVisionaryService().getStock()).toMatchObject({held: 1, remaining: 0});
		await pay(order.id, 'EXPIRED');

		await verify(order.id);

		expect((await stored(order.id)).status).toBe('expired');
		expect(await getVisionaryService().getStock()).toMatchObject({held: 0, remaining: 1});
	});
});
