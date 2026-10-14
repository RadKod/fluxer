// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {ShopOrderRow, ShopOrderStatus} from '@app/api/database/types/ShopTypes';
import {Logger} from '@app/api/Logger';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getShopOrderRepository} from '@app/api/middleware/ServiceSingletons';
import {createCallbackToken} from '@app/api/payriff/PayriffCallbackToken';
import {requestShopOrderVerify, SHOP_CALLBACK_CHECKS_PER_HOUR} from '@app/api/payriff/PayriffVerifyTrigger';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {fakePayriffServer} from '@app/api/test/Setup';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const ORDER_ID = 1490000000000000001n;
const CREATED_AT = new Date('2026-09-28T10:00:00Z');
const WEB_APP = Config.endpoints.webApp.replace(/\/+$/u, '');

describe('Payriff callback', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function seedOrder(status: ShopOrderStatus = 'pending'): Promise<{orderId: bigint; token: string}> {
		const {token, hash} = createCallbackToken();
		const row: ShopOrderRow = {
			order_id: ORDER_ID,
			user_id: createUserID(1490000000000000100n),
			sku: 'premium:1',
			item_id: null,
			item_ids: null,
			premium_months: 1,
			base_try_minor: 500,
			campaign_percent: 0,
			premium_percent: 0,
			amount_minor: 500,
			currency: 'TRY',
			status,
			failure_reason: status === 'failed' ? 'amount_mismatch' : null,
			provider: 'payriff',
			provider_order_id: 'payriff-order-1',
			provider_status: null,
			payment_url: 'https://pay.payriff.test/r/payriff-order-1?type=direct',
			callback_token_hash: hash,
			check_count: 0,
			next_check_at: null,
			created_at: CREATED_AT,
			updated_at: CREATED_AT,
			paid_at: null,
			granted_at: null,
			version: 1,
		};
		expect(await getShopOrderRepository().create(row)).toBe(true);
		return {orderId: ORDER_ID, token};
	}

	function captureJobs() {
		return vi.spyOn(NoopWorkerService.prototype, 'addJob');
	}

	function callback(method: 'GET' | 'POST', orderId: string, token: string, headers: Record<string, string> = {}) {
		return harness.requestJson({path: `/v1/payriff/callback/${orderId}/${token}`, method, headers});
	}

	function verifyJobs(jobs: ReturnType<typeof captureJobs>) {
		return (jobs.mock.calls as Array<Array<unknown>>).filter(([task]) => task === 'verifyShopOrder');
	}

	it('a wrong token answers 200 and neither queues work nor calls Payriff', async () => {
		const {orderId} = await seedOrder();
		const jobs = captureJobs();

		const post = await callback('POST', orderId.toString(), createCallbackToken().token);
		const get = await callback('GET', orderId.toString(), createCallbackToken().token);

		expect(post.status).toBe(200);
		expect(await post.json()).toEqual({received: true});
		expect(get.status).toBe(302);
		expect(get.headers.get('location')).toBe(`${WEB_APP}/premium-callback?status=pending`);
		expect(jobs).not.toHaveBeenCalled();
		expect(fakePayriffServer.calls()).toEqual([]);
	});

	it('an unknown or malformed order ID answers the same', async () => {
		const {token} = await seedOrder();
		const jobs = captureJobs();

		for (const orderId of ['1490000000000000002', 'abc', '0149', '-1', '9223372036854775808', '1'.repeat(25)]) {
			const post = await callback('POST', orderId, token);
			expect(post.status).toBe(200);
			expect(await post.json()).toEqual({received: true});
			const get = await callback('GET', orderId, token);
			expect(get.status).toBe(302);
			expect(get.headers.get('location')).toBe(`${WEB_APP}/premium-callback?status=pending`);
		}
		expect(jobs).not.toHaveBeenCalled();
		expect(fakePayriffServer.calls()).toEqual([]);
	});

	it('the right token queues one verification for many concurrent callbacks', async () => {
		const {orderId, token} = await seedOrder();
		const jobs = captureJobs();

		const responses = await Promise.all([
			...Array.from({length: 5}, () => callback('POST', orderId.toString(), token)),
			...Array.from({length: 2}, () => callback('GET', orderId.toString(), token)),
		]);

		expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 302, 302]);
		expect(verifyJobs(jobs)).toHaveLength(1);
		const payload = verifyJobs(jobs)[0]![1];
		expect(payload).toEqual({orderId: orderId.toString(), trigger: 'callback'});
		// Worker payloads travel as JSON (HttpWorkerQueue): a BigInt would not survive.
		expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
		expect(fakePayriffServer.calls()).toEqual([]);
	});

	it('a user replaying their own return link cannot spend more than ten checks an hour', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
		const {orderId, token} = await seedOrder();
		const jobs = captureJobs();

		for (let i = 0; i < 12; i++) {
			expect((await callback('GET', orderId.toString(), token)).status).toBe(302);
			vi.advanceTimersByTime(31_000);
		}
		expect(verifyJobs(jobs)).toHaveLength(SHOP_CALLBACK_CHECKS_PER_HOUR);

		vi.setSystemTime(new Date('2026-09-28T11:00:00Z'));
		await callback('GET', orderId.toString(), token);
		expect(verifyJobs(jobs)).toHaveLength(SHOP_CALLBACK_CHECKS_PER_HOUR + 1);
	});

	it('a reconcile in flight does not swallow a callback', async () => {
		const {orderId, token} = await seedOrder();
		const jobs = captureJobs();

		const deps = {kvClient: harness.kvProvider, workerService: getWorkerService()};
		expect(await requestShopOrderVerify(deps, orderId, 'reconcile', {slot: 5, shard: 1})).toBe(true);
		expect(await requestShopOrderVerify(deps, orderId, 'reconcile', {slot: 5, shard: 1})).toBe(false);
		await callback('POST', orderId.toString(), token);

		expect(verifyJobs(jobs).map(([, payload]) => payload)).toEqual([
			{orderId: orderId.toString(), trigger: 'reconcile', slot: 5, shard: 1, budgeted: true},
			{orderId: orderId.toString(), trigger: 'callback'},
		]);
	});

	it('the request log shows the callback path without the token', async () => {
		const {orderId, token} = await seedOrder();
		const requestLog = vi.spyOn(harness.logger, 'info');
		const appLogger = Logger.child({}) as unknown as NoopLogger;
		const appLogs = (['info', 'warn', 'error', 'fatal'] as const).map((level) => vi.spyOn(appLogger, level));

		await callback('GET', orderId.toString(), token);
		await callback('POST', orderId.toString(), token);

		const completed = (requestLog.mock.calls as Array<Array<unknown>>).filter(
			([, message]) => message === 'Request completed',
		);
		expect(completed.map(([data]) => (data as {path: string}).path)).toEqual([
			'/v1/payriff/callback/:order_id/:token',
			'/v1/payriff/callback/:order_id/:token',
		]);
		const everything = [...requestLog.mock.calls, ...appLogs.flatMap((spy) => spy.mock.calls)];
		expect(JSON.stringify(everything)).not.toContain(token);
	});

	it('a browser return goes to /premium-callback with no order detail', async () => {
		const {orderId, token} = await seedOrder();

		const response = await callback('GET', orderId.toString(), token);

		expect(response.status).toBe(302);
		const location = response.headers.get('location')!;
		expect(location).toBe(`${WEB_APP}/premium-callback?status=pending`);
		expect(location).not.toContain(orderId.toString());
		expect(location).not.toContain(token);
	});

	it.each([
		['paid', 'success'],
		['granted', 'success'],
		['failed', 'cancel'],
		['expired', 'pending'],
	] as const)('a browser return for a %s order shows %s', async (status, shown) => {
		const {orderId, token} = await seedOrder(status);

		const response = await callback('GET', orderId.toString(), token);

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(`${WEB_APP}/premium-callback?status=${shown}`);
	});

	it('a browser POST is redirected with 303', async () => {
		const {orderId, token} = await seedOrder();

		const response = await callback('POST', orderId.toString(), token, {accept: 'text/html,application/xhtml+xml'});

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe(`${WEB_APP}/premium-callback?status=pending`);
	});

	it('the callback lives under /payriff, not /webhooks', async () => {
		const {orderId, token} = await seedOrder();
		const jobs = captureJobs();

		await harness.requestJson({path: `/v1/webhooks/payriff/${orderId}/${token}`, method: 'POST'});
		expect(verifyJobs(jobs)).toHaveLength(0);

		await callback('POST', orderId.toString(), token);
		expect(verifyJobs(jobs)).toHaveLength(1);
	});

	it.each(['granted', 'failed'] as const)('a %s order queues nothing', async (status) => {
		const {orderId, token} = await seedOrder(status);
		const jobs = captureJobs();

		await callback('POST', orderId.toString(), token);
		await callback('GET', orderId.toString(), token);

		expect(jobs).not.toHaveBeenCalled();
		expect(fakePayriffServer.calls()).toEqual([]);
	});
});
