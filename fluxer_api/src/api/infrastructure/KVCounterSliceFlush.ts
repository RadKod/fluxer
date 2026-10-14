// SPDX-License-Identifier: AGPL-3.0-or-later

import {COUNTER_PARTITIONS, type KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {LoggerInterface} from '@fluxer/logger/src/LoggerInterface';

const BATCH = 1000;

export async function flushCounterSetSlice({
	counters,
	dirtySet,
	slice,
	minute,
	slices,
	budgetMs,
	concurrency,
	label,
	logger,
}: {
	counters: KVCounterService;
	dirtySet: string;
	slice: number;
	minute: number;
	slices: number;
	budgetMs: number;
	concurrency: number;
	label: {name: string; backlog: string};
	logger: Pick<LoggerInterface, 'error' | 'info' | 'warn'>;
}): Promise<void> {
	const partitionsPerSlice = COUNTER_PARTITIONS / slices;
	const start = minute % partitionsPerSlice;
	let round = Array.from(
		{length: partitionsPerSlice},
		(_, index) => slice * partitionsPerSlice + ((start + index) % partitionsPerSlice),
	);
	const startedAt = Date.now();
	const deadline = startedAt + budgetMs;
	let flushed = 0;
	let first = true;
	// Every partition gets a first batch. Later rounds revisit full partitions within the budget; rotating the
	// first partition each minute prevents a busy slice from always leaving the same partitions behind.
	let failed = 0;
	let firstError: unknown;
	do {
		const full = new Set<number>();
		await mapWithConcurrency(round, concurrency, async (partition) => {
			if (!first && Date.now() >= deadline) return;
			try {
				const batch = await counters.flushPartition(partition, BATCH, dirtySet);
				flushed += batch;
				if (batch === BATCH) full.add(partition);
			} catch (error) {
				if (failed++ === 0) firstError = error;
			}
		});
		first = false;
		round = round.filter((partition) => full.has(partition));
	} while (round.length > 0 && Date.now() < deadline);
	const ms = Date.now() - startedAt;
	// One error line per slice, not per partition, including during a KV outage.
	if (failed > 0) {
		logger.error(
			{slice, failed, error: firstError},
			`Failed to flush ${label.name} counter partitions; they stay dirty`,
		);
	}
	if (flushed > 0) logger.info({slice, flushed, ms}, `Flushed ${label.name} counters`);
	if (round.length > 0 && Date.now() >= deadline) {
		logger.warn(
			{slice, flushed, ms},
			`The ${label.name} flush slice used its whole ${budgetMs / 1000} s budget; ${label.backlog} are falling behind`,
		);
	}
}
