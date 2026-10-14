// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {getFeedPostService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({
	postId: z.string().regex(/^\d+$/),
	authorId: z.string().regex(/^\d+$/),
	before: z.string().regex(/^\d+$/).optional(),
});

// feed lane: writes one page of 500 followers' home feeds and queues the job for the next page. Rewriting a
// page on a retry is harmless (same rows); a deleted post, a deleted author or feature_feed at 0 ends the chain.
const fanoutFeedPost: WorkerTaskHandler = async (payload) => {
	const {postId, authorId, before} = PayloadSchema.parse(payload);
	await getFeedPostService().fanoutPage({
		postId: BigInt(postId),
		authorId: createUserID(BigInt(authorId)),
		before: before === undefined ? undefined : BigInt(before),
	});
};

export default fanoutFeedPost;
