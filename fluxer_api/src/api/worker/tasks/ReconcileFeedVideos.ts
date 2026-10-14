// SPDX-License-Identifier: AGPL-3.0-or-later

import {getFeedVideoService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// Micup feed video, hourly cron (only while Bunny Stream is configured): queues one reconcileFeedVideoBucket job per
// hour, shard and checkpoint since the last run, so a lost webhook never leaves a video waiting.
const reconcileFeedVideos: WorkerTaskHandler = async () => {
	await getFeedVideoService().enqueueReconcile();
};

export default reconcileFeedVideos;
