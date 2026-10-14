// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {FEED_VIEW_DIRTY_SET} from '@app/api/feed/interaction/FeedInteractionCounters';
import {flushCounterSetSlice} from '@app/api/infrastructure/KVCounterSliceFlush';
import {getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import {FEED_VIEW_FLUSH_SLICES} from '@app/api/worker/tasks/FlushFeedViewCounters';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const SLICE_BUDGET_MS = 45_000;

const Payload = z.object({
	slice: z
		.number()
		.int()
		.min(0)
		.max(FEED_VIEW_FLUSH_SLICES - 1),
	minute: z.number().int().nonnegative(),
});

const flushFeedViewCounterSlice: WorkerTaskHandler = async (payload, helpers) => {
	const {slice, minute} = Payload.parse(payload);
	await flushCounterSetSlice({
		counters: getKVCounterService(),
		dirtySet: FEED_VIEW_DIRTY_SET,
		slice,
		minute,
		slices: FEED_VIEW_FLUSH_SLICES,
		budgetMs: SLICE_BUDGET_MS,
		concurrency: Config.worker.feedViewFlushPartitionConcurrency,
		label: {name: 'feed view', backlog: 'view counts'},
		logger: helpers.logger,
	});
};

export default flushFeedViewCounterSlice;
