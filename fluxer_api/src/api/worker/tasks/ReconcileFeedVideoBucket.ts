// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUNNY_GUID_PATTERN} from '@app/api/feed/video/FeedVideoUrls';
import {getFeedVideoService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	hour: z.number().int(),
	shard: z.number().int().min(0).max(63),
	checkpoint: z.union([z.literal(1), z.literal(9), z.literal(72)]),
	after: z.string().regex(BUNNY_GUID_PATTERN).optional(),
	guid: z.string().regex(BUNNY_GUID_PATTERN).optional(),
});

// Micup feed video, video lane: one (hour, shard) of pending videos at its 1, 9 or 72 h checkpoint. A partition past
// 2 000 rows queues its rest; a video that could not be reconciled gets a job of its own (`guid`), which fails so the
// lane retries it.
const reconcileFeedVideoBucket: WorkerTaskHandler = async (payload) => {
	await getFeedVideoService().reconcileBucket(PayloadSchema.parse(payload));
};

export default reconcileFeedVideoBucket;
