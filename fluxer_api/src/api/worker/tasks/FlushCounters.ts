// SPDX-License-Identifier: AGPL-3.0-or-later

import {COUNTER_PARTITIONS} from '@app/api/infrastructure/KVCounterService';
import {getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

const FLUSH_BATCH_SIZE = 1000;
const FLUSH_TIME_BUDGET_MS = 8000;
// Partitions flushed at once; each flushes up to 8 counters at once, so this bounds stored writes per worker at 128.
const FLUSH_PARTITION_CONCURRENCY = 16;

const flushCounters: WorkerTaskHandler = async (_payload, helpers) => {
	const counters = getKVCounterService();
	const deadline = Date.now() + FLUSH_TIME_BUDGET_MS;
	const partitions = Array.from({length: COUNTER_PARTITIONS}, (_, partition) => partition);
	const perPartition = await mapWithConcurrency(partitions, FLUSH_PARTITION_CONCURRENCY, async (partition) => {
		let flushed = 0;
		try {
			for (;;) {
				const batch = await counters.flushPartition(partition, FLUSH_BATCH_SIZE);
				flushed += batch;
				if (batch < FLUSH_BATCH_SIZE || Date.now() >= deadline) {
					return flushed;
				}
			}
		} catch (error) {
			helpers.logger.error({error, partition}, 'Failed to flush a KV counter partition; it stays dirty');
			return flushed;
		}
	});
	const flushed = perPartition.reduce((sum, count) => sum + count, 0);
	if (flushed > 0) {
		helpers.logger.debug({flushed}, 'Flushed KV counters to Cassandra');
	}
	if (Date.now() >= deadline) {
		helpers.logger.warn(
			{flushed},
			'The counter flush used its whole 8 s budget; counters (and Keşfet) are falling behind',
		);
	}
};

export default flushCounters;
