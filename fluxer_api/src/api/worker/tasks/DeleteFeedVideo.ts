// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUNNY_GUID_PATTERN} from '@app/api/feed/video/FeedVideoUrls';
import {getFeedVideoService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guid: z.string().regex(BUNNY_GUID_PATTERN),
	priority: z.boolean().optional(),
	evidence: z.string().min(1).optional(),
});

// Micup feed video, video lane: a removed post, a failed or cancelled upload or a deleted account. A reported video's
// evidence is copied first; the Bunny video goes next and its row last. Failures reschedule the job, never throw.
const deleteFeedVideo: WorkerTaskHandler = async (payload) => {
	const {guid, priority, evidence} = PayloadSchema.parse(payload);
	await getFeedVideoService().deleteVideo(guid, {priority, evidence});
};

export default deleteFeedVideo;
