// SPDX-License-Identifier: AGPL-3.0-or-later

import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {CronScheduler} from '@app/api/worker/CronScheduler';
import {JOBS_STREAM_MAX_AGE_MS} from '@app/api/worker/JetStreamWorkerQueue';
import {registerCronJobs} from '@app/api/worker/WorkerMain';
import type {WorkerService} from '@app/api/worker/WorkerService';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('shop order reconcile cron', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// The reconcile budget refills 12 tokens in 10 s and a run spends at most what it holds: a run every 10 s is what
	// makes 1.2 checks a second.
	it('queues the reconcile every 10 seconds', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-15T12:00:00.500Z'));
		const addJob = vi.fn().mockResolvedValue(1n);
		const scheduler = new CronScheduler({addJob} as unknown as WorkerService, new NoopLogger());
		registerCronJobs(scheduler, JOBS_STREAM_MAX_AGE_MS);

		scheduler.start();
		await vi.advanceTimersByTimeAsync(60_000);
		await scheduler.stop();

		expect(addJob.mock.calls.filter(([task]) => task === 'reconcileShopOrders')).toHaveLength(6);
	});
});
