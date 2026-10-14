// SPDX-License-Identifier: AGPL-3.0-or-later

import {FeedEmbedService} from '@app/api/feed/FeedEmbedService';
import {getFeedPostService, getFeedRepository} from '@app/api/middleware/ServiceSingletons';
import {getWorkerDependencies} from '@app/api/worker/WorkerContext';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({postId: z.string().regex(/^\d+$/)});

// Micup feed, unfurl lane: resolves a post's one link preview and stores it on the row. A retry is harmless: a
// post that already has its preview, or is gone, ends the job. A link the moderation blocklist catches removes the post.
const extractFeedPostEmbeds: WorkerTaskHandler = async (payload) => {
	const {postId} = PayloadSchema.parse(payload);
	await new FeedEmbedService({
		feedRepository: getFeedRepository(),
		embedService: getWorkerDependencies().embedService,
		removePost: (post) => getFeedPostService().removePost(post, {priority: true}),
	}).extractPostEmbeds(BigInt(postId));
};

export default extractFeedPostEmbeds;
