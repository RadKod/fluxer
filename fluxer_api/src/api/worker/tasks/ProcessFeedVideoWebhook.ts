// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUNNY_GUID_PATTERN} from '@app/api/feed/video/FeedVideoUrls';
import {getFeedVideoService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guid: z.string().regex(BUNNY_GUID_PATTERN),
	recheck: z.number().int().min(0).optional(),
});

// Micup feed video, video lane: a signed Bunny webhook (or a 15 min re-read) re-reads the video from Bunny and moves
// it on. A retry re-reads again; a video that is gone or deleting ends the job.
const processFeedVideoWebhook: WorkerTaskHandler = async (payload) => {
	const {guid, recheck} = PayloadSchema.parse(payload);
	await getFeedVideoService().handleWebhook(guid, {recheck});
};

export default processFeedVideoWebhook;
