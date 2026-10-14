// SPDX-License-Identifier: AGPL-3.0-or-later

import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// the minute cron of the views lane. Each slice job flushes 64 of the 1024 partitions of the
// views dirty sets, so a minute's flush spreads over the lane's 16 slots instead of one job.
export const FEED_VIEW_FLUSH_SLICES = 16;

const flushFeedViewCounters: WorkerTaskHandler = async (_payload, helpers) => {
	const minute = Math.floor(Date.now() / 60_000);
	for (let slice = 0; slice < FEED_VIEW_FLUSH_SLICES; slice++) {
		await helpers.addJob(
			'flushFeedViewCounterSlice',
			{slice, minute},
			{jobKey: `feed-view-flush:${minute}:${slice}`, skipLedger: true},
		);
	}
};

export default flushFeedViewCounters;
