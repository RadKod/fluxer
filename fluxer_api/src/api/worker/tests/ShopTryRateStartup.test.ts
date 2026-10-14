// SPDX-License-Identifier: AGPL-3.0-or-later

import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {queueShopTryRateStartupJob} from '@app/api/worker/ShopTryRateStartup';
import {describe, expect, it, vi} from 'vitest';

describe('shop rate startup', () => {
	it('enqueues once across starters only when the automatic rate is missing', async () => {
		const kv = new MockKVProvider();
		const worker = {addJob: vi.fn(async () => 1n)};
		await queueShopTryRateStartupJob(kv, worker, async () => ({try_to_azn_rate_micro: 40_000}));
		expect(worker.addJob).not.toHaveBeenCalled();
		await queueShopTryRateStartupJob(kv, worker, async () => ({}));
		await queueShopTryRateStartupJob(kv, worker, async () => ({}));
		expect(worker.addJob).toHaveBeenCalledExactlyOnceWith('syncShopTryRate', {});
	});
	it('releases the startup claim when enqueue fails so the next startup can retry', async () => {
		const kv = new MockKVProvider();
		const worker = {addJob: vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(1n)};
		await queueShopTryRateStartupJob(kv, worker, async () => ({}));
		await queueShopTryRateStartupJob(kv, worker, async () => ({}));
		expect(worker.addJob).toHaveBeenCalledTimes(2);
	});
});
