// SPDX-License-Identifier: AGPL-3.0-or-later

import {drainDueJobs} from '@app/api/feed/video/FeedVideoService';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getFeedVideoRepository} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';

// Micup feed video, minute cron (only while Bunny Stream is configured): hands the video jobs whose wait was over a
// minute from their KV minute buckets to the queue, so they never wait as NAKed messages.
const drainFeedVideoJobs: WorkerTaskHandler = async () => {
	await drainDueJobs(getFeedVideoRepository(), getWorkerService());
};

export default drainFeedVideoJobs;
