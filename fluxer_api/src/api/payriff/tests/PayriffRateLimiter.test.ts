// SPDX-License-Identifier: AGPL-3.0-or-later

import {type PayriffBudget, PayriffRateLimiter} from '@app/api/payriff/PayriffRateLimiter';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const BUDGETS: ReadonlyArray<PayriffBudget> = ['create', 'verify', 'reconcile'];

async function acquire(limiter: PayriffRateLimiter, budget: PayriffBudget, times: number): Promise<Array<boolean>> {
	const results: Array<boolean> = [];
	for (let i = 0; i < times; i++) results.push(await limiter.tryAcquire(budget));
	return results;
}

describe('PayriffRateLimiter', () => {
	let kv: MockKVProvider;
	let limiter: PayriffRateLimiter;

	beforeEach(() => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
		kv = new MockKVProvider();
		limiter = new PayriffRateLimiter({kvClient: kv});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Every token each budget hands out right now.
	async function drain(budget: PayriffBudget): Promise<number> {
		let granted = 0;
		while (await limiter.tryAcquire(budget)) granted++;
		return granted;
	}

	it('keeps the three budgets apart', async () => {
		expect(await acquire(limiter, 'create', 7)).toEqual([...Array(6).fill(true), false]);
		expect(await acquire(limiter, 'verify', 11)).toEqual([...Array(10).fill(true), false]);
		expect(await acquire(limiter, 'reconcile', 13)).toEqual([...Array(12).fill(true), false]);
	});

	it('never lets more than 30 requests through at once, the burst Payriff was seen to allow', async () => {
		const burst = (await Promise.all(BUDGETS.map(drain))).reduce((sum, granted) => sum + granted, 0);

		expect(burst).toBeLessThanOrEqual(30);
	});

	it('refills at 2 requests a second in total, split 0.3 : 0.5 : 1.2 (plan-magaza K-bütçe)', async () => {
		await Promise.all(BUDGETS.map(drain));
		vi.advanceTimersByTime(10_000);

		const refilled = await Promise.all(BUDGETS.map(drain));

		expect(refilled).toEqual([3, 5, 12]);
	});

	it('gives reconcile runs 10 s apart 1.1 to 1.2 tokens a second, each run a few ms early or late', async () => {
		await drain('reconcile');
		const start = Date.now();
		let granted = 0;
		for (const [run, driftMs] of [-3, 2, -7, 0, -1, 5, -4, 1, -2, 3].entries()) {
			vi.setSystemTime(start + (run + 1) * 10_000 + driftMs);
			granted += await drain('reconcile');
		}

		const perSecond = granted / ((Date.now() - start) / 1000);
		expect(perSecond).toBeGreaterThanOrEqual(1.1);
		expect(perSecond).toBeLessThanOrEqual(1.2);
	});

	it('refills over time', async () => {
		await acquire(limiter, 'verify', 10);
		vi.advanceTimersByTime(1_000);
		expect(await limiter.tryAcquire('verify')).toBe(false);
		vi.advanceTimersByTime(1_000);
		expect(await acquire(limiter, 'verify', 2)).toEqual([true, false]);
	});

	it('backs everyone off after a 429', async () => {
		await limiter.backOff();

		expect(await limiter.isBackingOff()).toBe(true);
		expect(await limiter.tryAcquire('create')).toBe(false);
		expect(await limiter.tryAcquire('verify')).toBe(false);
		expect(await limiter.tryAcquire('reconcile')).toBe(false);
		vi.advanceTimersByTime(29_000);
		expect(await limiter.tryAcquire('verify')).toBe(false);
		vi.advanceTimersByTime(1_000);
		expect(await limiter.isBackingOff()).toBe(false);
		expect(await limiter.tryAcquire('create')).toBe(true);
		expect(await limiter.tryAcquire('verify')).toBe(true);
		expect(await limiter.tryAcquire('reconcile')).toBe(true);
	});

	it('counts busy refusals for the current and the previous hour only', async () => {
		await limiter.recordBusyRefusal();
		vi.setSystemTime(new Date('2026-09-28T11:30:00Z'));
		await limiter.recordBusyRefusal();
		await limiter.recordBusyRefusal();
		expect(await limiter.busyRefusalsLastHour()).toBe(3);

		vi.setSystemTime(new Date('2026-09-28T12:10:00Z'));
		expect(await limiter.busyRefusalsLastHour()).toBe(2);
		expect(kv.expireSpy).toHaveBeenCalledWith('shop:busy:497387', 7200);
	});
});
