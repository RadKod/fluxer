// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUNNY_GUID_PATTERN} from '@app/api/feed/video/FeedVideoUrls';
import {getFeedVideoService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guid: z.string().regex(BUNNY_GUID_PATTERN),
	attempt: z.number().int().min(0),
});

// Micup feed video, video lane: scans a finished video's frames and publishes it only when the scan is clean. One scan
// runs per attempt; an inconclusive scan queues the next attempt itself instead of failing the job.
const scanFeedVideo: WorkerTaskHandler = async (payload) => {
	const {guid, attempt} = PayloadSchema.parse(payload);
	await getFeedVideoService().scan(guid, attempt);
};

export default scanFeedVideo;
