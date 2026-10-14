// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {SHOP_ORDER_CHECK_SHARDS, SHOP_ORDER_CHECK_SLOT_MS, type ShopOrderRow} from '@app/api/database/types/ShopTypes';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getShopOrderRepository} from '@app/api/middleware/ServiceSingletons';
import {createCallbackToken} from '@app/api/payriff/PayriffCallbackToken';
import {PayriffClient} from '@app/api/payriff/PayriffClient';
import {PayriffRateLimiter} from '@app/api/payriff/PayriffRateLimiter';
import type {VerifyShopOrderPayload} from '@app/api/payriff/PayriffVerifyTrigger';
import {PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import {ShopOrderRepository, shopOrderCheckShard, shopOrderCheckSlot} from '@app/api/shop/ShopOrderRepository';
import {createShopAdmin, openShop, saveShopEnvironment, setPrices} from '@app/api/shop/tests/ShopTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {fakePayriffServer} from '@app/api/test/Setup';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import reconcileShopOrders from '@app/api/worker/tasks/ReconcileShopOrders';
import verifyShopOrder from '@app/api/worker/tasks/VerifyShopOrder';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import type {ShopAdminResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
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
// A slot boundary: 5 minute slots start on the hour.
const T0 = new Date('2026-10-15T12:00:00.000Z').getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SCHEDULE = [2 * MINUTE, 15 * MINUTE, 3 * HOUR, 24 * HOUR];

describe('shop order reconcile', () => {
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
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(T0);
		admin = await createShopAdmin(harness);
		user = await createTestAccount(harness);
		await openShop(harness, admin);
		await setPrices(harness, admin, {'premium:1': 500});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
		restoreEnvironment();
	});

	function at(offsetMs: number): void {
		vi.setSystemTime(T0 + offsetMs);
	}

	function createOrder(sku = 'premium:1') {
		return createBuilder<ShopOrderResponse>(harness, user.token).post('/shop/orders').body({sku}).expect(200).execute();
	}

	async function stored(id: string | bigint): Promise<ShopOrderRow> {
		return (await getShopOrderRepository().find(BigInt(id)))!;
	}

	function reconcile() {
		return reconcileShopOrders({}, HELPERS);
	}

	// verifyShopOrder jobs queued since the capture started; runJobs runs the ones not run yet.
	function captureVerifyJobs() {
		const addJob = vi.spyOn(NoopWorkerService.prototype, 'addJob');
		let started = 0;
		const queued = () =>
			(addJob.mock.calls as Array<Array<unknown>>)
				.filter(([task]) => task === 'verifyShopOrder')
				.map(([, payload]) => payload as unknown as VerifyShopOrderPayload);
		return {
			queued,
			runJobs: async () => {
				const fresh = queued().slice(started);
				started += fresh.length;
				await Promise.all(fresh.map((payload) => verifyShopOrder({...payload}, HELPERS)));
				return fresh.length;
			},
		};
	}

	function payriffGets(): number {
		return fakePayriffServer.calls().filter((call) => call.operation === 'get').length;
	}

	// Every check row of the order in the slots its schedule can use.
	async function checkRowsOf(orderId: bigint) {
		const slots = new Set<number>();
		for (let offset = 0; offset <= 26 * HOUR; offset += SHOP_ORDER_CHECK_SLOT_MS)
			slots.add(shopOrderCheckSlot(new Date(T0 + offset)));
		const rows = [];
		for (const slot of slots) {
			rows.push(...(await getShopOrderRepository().listChecks(slot, shopOrderCheckShard(orderId), 500)));
		}
		return rows.filter((row) => row.order_id === orderId);
	}

	async function seedOrder(orderId: bigint, dueAt: number, created = new Date(dueAt - 2 * MINUTE), checkCount = 0) {
		await getShopOrderRepository().create({
			order_id: orderId,
			user_id: createUserID(BigInt(user.userId)),
			sku: 'premium:1',
			item_id: null,
			item_ids: null,
			premium_months: 1,
			base_usd_cents: 500,
			campaign_percent: 0,
			premium_percent: 0,
			final_usd_cents: 500,
			rate_micro: 1_700_000,
			amount_minor: 850,
			display_currency: null,
			display_amount_minor: null,
			display_rate_micro: null,
			currency: 'AZN',
			status: 'pending',
			failure_reason: null,
			provider: 'payriff',
			provider_order_id: `payriff-seed-${orderId}`,
			provider_status: null,
			payment_url: 'https://pay.payriff.test/r/seed',
			callback_token_hash: createCallbackToken().hash,
			check_count: checkCount,
			next_check_at: new Date(dueAt),
			created_at: created,
			updated_at: created,
			paid_at: null,
			granted_at: null,
			version: 1,
		});
	}

	it('checks at +2 min, +15 min, +3 h, +24 h, then expires', async () => {
		const order = await createOrder();
		const jobs = captureVerifyJobs();

		for (const [index, due] of SCHEDULE.entries()) {
			at(due - 30_000);
			await reconcile();
			expect(await jobs.runJobs(), `before check ${index + 1}`).toBe(0);
			at(due);
			await reconcile();
			expect(await jobs.runJobs(), `check ${index + 1}`).toBe(1);
			expect(payriffGets()).toBe(index + 1);
		}

		const row = await stored(order.id);
		expect(row).toMatchObject({status: 'expired', check_count: 4, next_check_at: null});
		expect(await checkRowsOf(row.order_id)).toEqual([]);
		at(26 * HOUR);
		await reconcile();
		expect(await jobs.runJobs()).toBe(0);
	});

	it('reconcile never spends the callback budget', async () => {
		await createOrder();
		const tryAcquire = vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire');
		const jobs = captureVerifyJobs();

		at(2 * MINUTE);
		await reconcile();
		await jobs.runJobs();

		expect(tryAcquire.mock.calls).toEqual([['reconcile']]);
		expect(jobs.queued()).toEqual([expect.objectContaining({trigger: 'reconcile', budgeted: true})]);
		expect(payriffGets()).toBe(1);
	});

	it('stops at the reconcile budget and leaves the rest for the next minute', async () => {
		await reconcile();
		const ids = Array.from({length: 20}, (_, i) => 1490000000000000100n + BigInt(i));
		for (const id of ids) await seedOrder(id, T0 + 2 * MINUTE);
		const jobs = captureVerifyJobs();

		at(6 * MINUTE);
		await reconcile();
		expect(jobs.queued()).toHaveLength(12);
		expect(await getKVClient().get('shop:checks:cursor')).toBe(String(shopOrderCheckSlot(new Date(T0))));

		at(7 * MINUTE);
		await reconcile();
		expect(new Set(jobs.queued().map((payload) => payload.orderId))).toEqual(new Set(ids.map(String)));

		await jobs.runJobs();
		at(8 * MINUTE);
		await reconcile();
		expect(await getKVClient().get('shop:checks:cursor')).toBe(String(shopOrderCheckSlot(new Date(T0 + 8 * MINUTE))));
	});

	it('a failed order leaves the schedule', async () => {
		const order = await createOrder();
		const row = await stored(order.id);
		fakePayriffServer.setAmount(row.provider_order_id!, 1);
		fakePayriffServer.setStatus(row.provider_order_id!, 'APPROVED');
		const jobs = captureVerifyJobs();

		at(2 * MINUTE);
		await reconcile();
		await jobs.runJobs();

		expect((await stored(order.id)).status).toBe('failed');
		expect(await checkRowsOf(row.order_id)).toEqual([]);
		at(15 * MINUTE);
		await reconcile();
		expect(await jobs.runJobs()).toBe(0);
	});

	it('a callback-granted order leaves the schedule', async () => {
		const order = await createOrder();
		const row = await stored(order.id);
		fakePayriffServer.setStatus(row.provider_order_id!, 'APPROVED');
		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);
		expect((await stored(order.id)).status).toBe('granted');
		expect(await checkRowsOf(row.order_id)).toEqual([]);
		const jobs = captureVerifyJobs();

		at(2 * MINUTE);
		await reconcile();

		expect(jobs.queued()).toEqual([]);
	});

	it('a paid order leaves the schedule', async () => {
		const order = await createOrder();
		const row = await stored(order.id);
		fakePayriffServer.setStatus(row.provider_order_id!, 'APPROVED');
		const jobs = captureVerifyJobs();

		at(2 * MINUTE);
		await reconcile();
		await jobs.runJobs();

		expect((await stored(order.id)).status).toBe('granted');
		expect(await checkRowsOf(row.order_id)).toEqual([]);
	});

	it('a Payriff create failure leaves the schedule', async () => {
		fakePayriffServer.failNext('create', 'server_error');
		await createBuilder(harness, user.token).post('/shop/orders').body({sku: 'premium:1'}).expect(503).execute();
		const [entry] = await getShopOrderRepository().listForUser(createUserID(BigInt(user.userId)), 1);
		expect(await checkRowsOf(entry!.order_id)).toEqual([]);
		const jobs = captureVerifyJobs();

		at(2 * MINUTE);
		await reconcile();

		expect(jobs.queued()).toEqual([]);
	});

	it('not found and error codes count as checks', async () => {
		const order = await createOrder();
		const jobs = captureVerifyJobs();
		const outcomes: Array<'bad_code' | 'not_found'> = ['bad_code', 'not_found', 'bad_code', 'not_found'];

		for (const [index, due] of SCHEDULE.entries()) {
			if (outcomes[index] === 'bad_code') {
				fakePayriffServer.failNext('get', 'bad_code');
			} else {
				const row = await stored(order.id);
				await getShopOrderRepository().patch(row.order_id, {provider_order_id: 'payriff-unknown'}, row.version);
			}
			at(due);
			await reconcile();
			await jobs.runJobs();
			const row = await stored(order.id);
			expect(row.check_count, `check ${index + 1}`).toBe(index + 1);
		}

		expect(await stored(order.id)).toMatchObject({status: 'expired', next_check_at: null});
		expect(await checkRowsOf(BigInt(order.id))).toEqual([]);
	});

	function runCheck(orderId: bigint, dueAt: Date) {
		return verifyShopOrder(
			{
				orderId: `${orderId}`,
				trigger: 'reconcile',
				budgeted: true,
				slot: shopOrderCheckSlot(dueAt),
				shard: shopOrderCheckShard(orderId),
			},
			HELPERS,
		);
	}

	it('two jobs for the same check keep the next check row', async () => {
		const order = await createOrder();
		const row = await stored(order.id);

		at(2 * MINUTE);
		await Promise.all([runCheck(row.order_id, row.next_check_at!), runCheck(row.order_id, row.next_check_at!)]);

		const checked = await stored(order.id);
		expect(checked.check_count).toBe(1);
		expect((await checkRowsOf(checked.order_id)).map((check) => check.due_at.getTime())).toEqual([
			checked.next_check_at!.getTime(),
		]);
	});

	it('a late check whose next one lands in the same slot keeps that row', async () => {
		const orderId = 1490000000000000100n;
		await seedOrder(orderId, T0 + MINUTE, new Date(T0 - 4 * HOUR), 1);

		at(MINUTE);
		await runCheck(orderId, new Date(T0 + MINUTE));

		const checked = await stored(orderId);
		expect(checked.check_count).toBe(2);
		expect(shopOrderCheckSlot(checked.next_check_at!)).toBe(shopOrderCheckSlot(new Date(T0 + MINUTE)));
		expect((await checkRowsOf(orderId)).map((check) => check.due_at.getTime())).toEqual([
			checked.next_check_at!.getTime(),
		]);
	});

	it('a late payment is delivered by reconcile after the callback job gave up on a locked delivery', async () => {
		const order = await createOrder();
		const row = await stored(order.id);
		fakePayriffServer.setStatus(row.provider_order_id!, 'EXPIRED');
		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);
		expect(await stored(order.id)).toMatchObject({status: 'expired', next_check_at: null});
		fakePayriffServer.setStatus(row.provider_order_id!, 'APPROVED');
		const locked = vi.spyOn(PremiumLedgerService.prototype, 'grant').mockRejectedValue(new ResourceLockedError());
		// The last attempt: the callback job does not queue itself again.
		await verifyShopOrder({orderId: order.id, trigger: 'callback', attempt: 30}, HELPERS);
		expect((await stored(order.id)).status).toBe('paid');
		locked.mockRestore();
		const jobs = captureVerifyJobs();

		at(2 * MINUTE);
		await reconcile();
		await jobs.runJobs();

		expect((await stored(order.id)).status).toBe('granted');
		expect(await checkRowsOf(row.order_id)).toEqual([]);
	});

	it('a late payment writes its check row before the order: a crash between them leaves no check without a row', async () => {
		const order = await createOrder();
		const row = await stored(order.id);
		fakePayriffServer.setStatus(row.provider_order_id!, 'EXPIRED');
		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);
		fakePayriffServer.setStatus(row.provider_order_id!, 'APPROVED');
		vi.spyOn(ShopOrderRepository.prototype, 'scheduleCheck').mockRejectedValueOnce(new Error('worker died'));

		await expect(verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS)).rejects.toThrow('worker died');
		expect(await stored(order.id)).toMatchObject({status: 'expired', next_check_at: null});

		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);
		expect((await stored(order.id)).status).toBe('granted');
		expect(await checkRowsOf(row.order_id)).toEqual([]);
	});

	it('a payment whose order expires just before it is marked paid asks Payriff once and keeps a check row', async () => {
		const order = await createOrder();
		const row = await stored(order.id);
		fakePayriffServer.setStatus(row.provider_order_id!, 'APPROVED');
		const patch = ShopOrderRepository.prototype.patch;
		// Reconcile's last check expires the order between this job's read and its paid write.
		vi.spyOn(ShopOrderRepository.prototype, 'patch').mockImplementationOnce(async function (
			this: ShopOrderRepository,
			orderId,
			change,
			version,
		) {
			const current = (await this.find(orderId))!;
			await patch.call(this, orderId, {status: 'expired', next_check_at: null}, current.version);
			await this.deletePendingCheck(current);
			return patch.call(this, orderId, change, version);
		});
		vi.spyOn(PremiumLedgerService.prototype, 'grant').mockRejectedValue(new ResourceLockedError());
		const gets = payriffGets();

		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);

		expect(payriffGets()).toBe(gets + 1);
		const paid = await stored(order.id);
		expect(paid.status).toBe('paid');
		expect((await checkRowsOf(paid.order_id)).map((check) => check.due_at.getTime())).toEqual([
			paid.next_check_at!.getTime(),
		]);
	});

	it('a late payment another job delivers while this one asks Payriff leaves no check row', async () => {
		const order = await createOrder();
		const row = await stored(order.id);
		fakePayriffServer.setStatus(row.provider_order_id!, 'EXPIRED');
		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);
		fakePayriffServer.setStatus(row.provider_order_id!, 'APPROVED');
		const getOrder = PayriffClient.prototype.getOrder;
		vi.spyOn(PayriffClient.prototype, 'getOrder').mockImplementationOnce(async function (
			this: PayriffClient,
			providerOrderId,
		) {
			const answer = await getOrder.call(this, providerOrderId);
			// A second job reads the same payment and delivers it first.
			await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);
			return answer;
		});

		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);

		expect((await stored(order.id)).status).toBe('granted');
		expect(await checkRowsOf(row.order_id)).toEqual([]);
	});

	it('a check a worker runs by a clock a few seconds behind still counts', async () => {
		const order = await createOrder();
		const row = await stored(order.id);

		at(SCHEDULE[0]! - 5_000);
		await runCheck(row.order_id, row.next_check_at!);

		const checked = await stored(order.id);
		expect(checked.check_count).toBe(1);
		expect(checked.next_check_at!.getTime()).toBe(T0 + SCHEDULE[1]!);
	});

	it('a late check is never scheduled behind the cursor', async () => {
		await reconcile();
		const order = await createOrder();
		const jobs = captureVerifyJobs();

		at(3 * HOUR + 7 * MINUTE);
		await reconcile();
		await jobs.runJobs();

		const row = await stored(order.id);
		expect(row.check_count).toBe(1);
		expect(row.next_check_at!.getTime()).toBeGreaterThanOrEqual(Date.now() + MINUTE);
		expect((await checkRowsOf(row.order_id)).map((check) => check.due_at.getTime())).toEqual([
			row.next_check_at!.getTime(),
		]);
	});

	it('the first run starts at the current slot', async () => {
		const listChecks = vi.spyOn(ShopOrderRepository.prototype, 'listChecks');

		at(3 * HOUR);
		await reconcile();

		expect(listChecks).toHaveBeenCalledTimes(SHOP_ORDER_CHECK_SHARDS);
		const current = shopOrderCheckSlot(new Date());
		expect(new Set(listChecks.mock.calls.map(([slot]) => slot))).toEqual(new Set([current]));
		expect(await getKVClient().get('shop:checks:cursor')).toBe(String(current));
	});

	it('a slot the job missed is caught up through the cursor', async () => {
		await reconcile();
		const order = await createOrder();
		const jobs = captureVerifyJobs();

		at(2 * HOUR);
		await reconcile();

		expect(jobs.queued().map((payload) => payload.orderId)).toEqual([order.id]);
		await jobs.runJobs();
		expect((await stored(order.id)).check_count).toBe(1);
	});

	it('reports the reconcile lag for the admin page', async () => {
		await reconcile();
		await createOrder();
		vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire').mockResolvedValue(false);

		at(2 * HOUR);
		await reconcile();

		expect(await getKVClient().get('shop:checks:lag')).toBe(String(2 * 3600));
		const view = await createBuilder<ShopAdminResponse>(harness, admin.token).get('/admin/shop').execute();
		expect(view.health.reconcile_lag_seconds).toBe(2 * 3600);
	});

	it('warns once the reconcile lag passes 15 minutes', async () => {
		await reconcile();
		await createOrder();
		vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire').mockResolvedValue(false);
		const warn = vi.spyOn(HELPERS.logger, 'warn');

		at(14 * MINUTE);
		await reconcile();
		expect(warn).not.toHaveBeenCalled();

		at(16 * MINUTE);
		await reconcile();
		expect(warn).toHaveBeenCalledWith(
			{lagSeconds: 16 * 60, queued: 0},
			'Shop order reconcile is more than 15 minutes behind',
		);
	});

	it('runs 10 s apart each queue what the budget refilled and spend one token per order', async () => {
		await reconcile();
		const ids = Array.from({length: 30}, (_, i) => 1490000000000000100n + BigInt(i));
		for (const id of ids) await seedOrder(id, T0 + 2 * MINUTE);
		const jobs = captureVerifyJobs();
		const tryAcquire = vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire');

		at(6 * MINUTE);
		await reconcile();
		expect(jobs.queued()).toHaveLength(12);
		at(6 * MINUTE + 10_000);
		await reconcile();
		expect(jobs.queued()).toHaveLength(24);
		at(6 * MINUTE + 20_000);
		await reconcile();

		expect(jobs.queued().map((payload) => payload.orderId)).toEqual(expect.arrayContaining(ids.map(String)));
		expect(jobs.queued()).toHaveLength(30);
		const granted = await Promise.all(tryAcquire.mock.results.map((result) => result.value as Promise<boolean>));
		expect(granted.filter(Boolean)).toHaveLength(30);
	});

	it('two runs at once spend the budget once', async () => {
		await reconcile();
		const ids = Array.from({length: 20}, (_, i) => 1490000000000000100n + BigInt(i));
		for (const id of ids) await seedOrder(id, T0 + 2 * MINUTE);
		const jobs = captureVerifyJobs();

		at(6 * MINUTE);
		await Promise.all([reconcile(), reconcile()]);

		expect(jobs.queued()).toHaveLength(12);
		expect(new Set(jobs.queued().map((payload) => payload.orderId)).size).toBe(12);
	});

	// An expired order whose late payment the callback job never read (no verify budget for its 30 tries).
	async function expiredOrderWhoseCallbackGaveUp(paymentStatus: string) {
		const order = await createOrder();
		const row = await stored(order.id);
		fakePayriffServer.setStatus(row.provider_order_id!, 'EXPIRED');
		await verifyShopOrder({orderId: order.id, trigger: 'callback'}, HELPERS);
		expect(await stored(order.id)).toMatchObject({status: 'expired', next_check_at: null});
		fakePayriffServer.setStatus(row.provider_order_id!, paymentStatus);
		const gets = payriffGets();
		const noBudget = vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire').mockResolvedValue(false);
		await verifyShopOrder({orderId: order.id, trigger: 'callback', attempt: 30}, HELPERS);
		noBudget.mockRestore();
		expect(payriffGets()).toBe(gets);
		return row;
	}

	it('a callback job that gives up leaves the order to reconcile', async () => {
		const row = await expiredOrderWhoseCallbackGaveUp('APPROVED');
		expect((await stored(row.order_id)).status).toBe('expired');
		const jobs = captureVerifyJobs();

		at(MINUTE - 1_000);
		await reconcile();
		expect(await jobs.runJobs()).toBe(0);
		at(MINUTE);
		await reconcile();
		expect(await jobs.runJobs()).toBe(1);

		expect((await stored(row.order_id)).status).toBe('granted');
		expect(await checkRowsOf(row.order_id)).toEqual([]);
	});

	it('the check a gave-up callback job leaves an expired order is its last when Payriff shows no payment', async () => {
		const row = await expiredOrderWhoseCallbackGaveUp('EXPIRED');
		const jobs = captureVerifyJobs();
		const gets = payriffGets();

		at(MINUTE);
		await reconcile();
		await jobs.runJobs();

		expect(payriffGets()).toBe(gets + 1);
		expect(await stored(row.order_id)).toMatchObject({status: 'expired', next_check_at: null});
		expect(await checkRowsOf(row.order_id)).toEqual([]);
	});

	it('a check a gave-up callback job pulled ahead does not count: the last one stays at +24 h', async () => {
		const orderId = 1490000000000000100n;
		const lastCheck = T0 + 20 * HOUR;
		await seedOrder(orderId, lastCheck, new Date(T0 - 4 * HOUR), 3);
		const noBudget = vi.spyOn(PayriffRateLimiter.prototype, 'tryAcquire').mockResolvedValue(false);
		await verifyShopOrder({orderId: `${orderId}`, trigger: 'callback', attempt: 30}, HELPERS);
		noBudget.mockRestore();
		expect((await stored(orderId)).next_check_at!.getTime()).toBe(T0 + MINUTE);
		const jobs = captureVerifyJobs();

		at(MINUTE);
		await reconcile();
		expect(await jobs.runJobs()).toBe(1);

		const checked = await stored(orderId);
		expect(checked).toMatchObject({status: 'pending', check_count: 3});
		expect(checked.next_check_at!.getTime()).toBe(lastCheck);
		expect((await checkRowsOf(orderId)).map((check) => check.due_at.getTime())).toEqual([lastCheck]);
	});
});
