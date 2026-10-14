// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {
	getCosmeticRepository,
	getPremiumLedgerRepository,
	getShopOrderRepository,
	getUserRepository,
	getVisionaryService,
} from '@app/api/middleware/ServiceSingletons';
import type {VerifyShopOrderPayload} from '@app/api/payriff/PayriffVerifyTrigger';
import {clearVisionarySlots} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {
	createShopAdmin,
	createShopItem,
	openShop,
	saveShopEnvironment,
	setPrices,
} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {fakePayriffServer} from '@app/api/test/Setup';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import verifyShopOrder from '@app/api/worker/tasks/VerifyShopOrder';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

function userUpdateCount(dispatch: {mock: {calls: Array<Array<{event: string}>>}}): number {
	return dispatch.mock.calls.filter(([params]) => params?.event === 'USER_UPDATE').length;
}

const HELPERS: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};
const DAY_MS = 24 * 3_600_000;

describe('one delivery per paid shop order', () => {
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

	// Opens an order for the sku and has Payriff approve it; the callback token comes from the URL Payriff was given.
	async function openPaidOrder(sku: string): Promise<{order: ShopOrderResponse; token: string}> {
		const order = await createBuilder<ShopOrderResponse>(harness, user.token)
			.post('/shop/orders')
			.body({sku})
			.expect(200)
			.execute();
		const create = fakePayriffServer.calls().find((call) => call.operation === 'create')!;
		const url = (create.body as {callbackUrl: string}).callbackUrl;
		fakePayriffServer.setStatus(create.providerOrderId!, 'APPROVED');
		return {order, token: url.slice(url.lastIndexOf('/') + 1)};
	}

	async function openPaidCosmeticOrder() {
		await openShop(harness, admin);
		const item = await createShopItem(harness, admin, 'owned');
		await setPrices(harness, admin, {[`cosmetic:${item.id}`]: 300});
		return openPaidOrder(`cosmetic:${item.id}`);
	}

	// Collects the verifyShopOrder jobs the API queued; each call runs the ones not run yet.
	function captureVerifyJobs(): () => Array<Promise<unknown>> {
		const addJob = vi.spyOn(NoopWorkerService.prototype, 'addJob');
		let started = 0;
		return () => {
			const payloads = (addJob.mock.calls as Array<Array<unknown>>)
				.filter(([task]) => task === 'verifyShopOrder')
				.map(([, payload]) => payload as unknown as VerifyShopOrderPayload);
			const fresh = payloads.slice(started);
			started = payloads.length;
			return fresh.map((payload) => verifyShopOrder({...payload}, HELPERS));
		};
	}

	function postCallback(orderId: string, token: string) {
		return harness.requestJson({path: `/v1/payriff/callback/${orderId}/${token}`, method: 'POST'});
	}

	function getCallback(orderId: string, token: string) {
		return harness.requestJson({path: `/v1/payriff/callback/${orderId}/${token}`, method: 'GET'});
	}

	async function everyTrigger(orderId: string, token: string): Promise<void> {
		const runJobs = captureVerifyJobs();
		await Promise.all([
			...Array.from({length: 5}, () => postCallback(orderId, token)),
			getCallback(orderId, token),
			getCallback(orderId, token),
		]);
		await Promise.all([...runJobs(), verifyShopOrder({orderId, trigger: 'reconcile', budgeted: true}, HELPERS)]);
		await Promise.all(runJobs());
	}

	it('5 callbacks, 2 returns and a reconcile deliver once', async () => {
		const {order, token} = await openPaidCosmeticOrder();
		const grantOwned = vi.spyOn(CosmeticService.prototype, 'grantOwned');

		await everyTrigger(order.id, token);

		expect(grantOwned).toHaveBeenCalledTimes(1);
		expect(await getCosmeticRepository().listOwned(userId)).toHaveLength(1);
		expect((await getShopOrderRepository().find(BigInt(order.id)))?.status).toBe('granted');
	});

	it('a cosmetic order verified by 7 concurrent jobs is delivered once', async () => {
		const {order} = await openPaidCosmeticOrder();
		const grantOwned = vi.spyOn(CosmeticService.prototype, 'grantOwned');

		await Promise.allSettled(
			Array.from({length: 7}, () => verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS)),
		);

		expect(grantOwned).toHaveBeenCalledTimes(1);
		expect(await getCosmeticRepository().listOwned(userId)).toHaveLength(1);
		expect((await getShopOrderRepository().find(BigInt(order.id)))?.status).toBe('granted');
	});

	it('a premium order verified by 7 concurrent jobs adds one month', async () => {
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
		const {order} = await openPaidOrder('premium:1');
		const before = Date.now();

		await Promise.allSettled(
			Array.from({length: 7}, () => verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS)),
		);

		expect((await getShopOrderRepository().find(BigInt(order.id)))?.status).toBe('granted');
		const paidUntil = (await getPremiumLedgerRepository().find(userId))!.paid_until!.getTime();
		expect(paidUntil - before).toBeGreaterThan(27 * DAY_MS);
		expect(paidUntil - before).toBeLessThan(32 * DAY_MS);
	});

	it('a delivery that crashed after the grant finishes without a second grant', async () => {
		const {order} = await openPaidCosmeticOrder();
		const grantOwned = vi.spyOn(CosmeticService.prototype, 'grantOwned');
		vi.spyOn(CosmeticRepository.prototype, 'markGrantDelivered').mockRejectedValueOnce(new Error('worker died'));

		await expect(verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS)).rejects.toThrow('worker died');
		expect((await getShopOrderRepository().find(BigInt(order.id)))?.status).toBe('paid');
		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);

		expect(grantOwned).toHaveBeenCalledTimes(1);
		expect(await getCosmeticRepository().listOwned(userId)).toHaveLength(1);
		expect((await getShopOrderRepository().find(BigInt(order.id)))?.status).toBe('granted');
	});

	it('5 callbacks, 2 returns and a reconcile give one Visionary number and one USER_UPDATE', async () => {
		await openShop(harness, admin, {visionary_on_sale: true});
		await setPrices(harness, admin, {visionary: 5000});
		await clearVisionarySlots();
		await getVisionaryService().setTotal(3);
		const {order, token} = await openPaidOrder('visionary');
		const userUpdates = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');

		await everyTrigger(order.id, token);

		expect(userUpdateCount(userUpdates)).toBe(1);
		const buyer = (await getUserRepository().findUnique(userId))!;
		expect([buyer.premiumType, buyer.premiumLifetimeSequence]).toEqual([UserPremiumTypes.LIFETIME, 1]);
		expect(await getVisionaryService().getStock()).toMatchObject({sold: 1, held: 0, remaining: 2});
		expect((await getShopOrderRepository().find(BigInt(order.id)))?.status).toBe('granted');
	});
});
