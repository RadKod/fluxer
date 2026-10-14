// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUNNY_GUID_PATTERN} from '@app/api/feed/video/FeedVideoUrls';
import {getFeedVideoService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	guid: z.string().regex(BUNNY_GUID_PATTERN),
	evidenceKey: z.string().min(1),
});

// Micup feed video, video lane: a reported video's HLS segments are joined into the reports bucket. A copy that is
// already there ends the job; a failed one queues itself again.
const keepFeedVideoEvidence: WorkerTaskHandler = async (payload) => {
	const {guid, evidenceKey} = PayloadSchema.parse(payload);
	await getFeedVideoService().keepEvidence(guid, evidenceKey);
};

export default keepFeedVideoEvidence;
