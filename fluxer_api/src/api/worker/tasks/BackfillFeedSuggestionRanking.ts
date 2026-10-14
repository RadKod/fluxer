// SPDX-License-Identifier: AGPL-3.0-or-later

import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getFeedSuggestionService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const PayloadSchema = z.object({page_state: z.string().nullable()});

// batch lane: one stretch of the follower ranking backfill, then the job for the next one. A retry
// ranks the same stretch again (repeatable); the last job marks the ranking filled. Only the suggestion build queues
// the first job (FeedSuggestionService.queueBackfill).
const backfillFeedSuggestionRanking: WorkerTaskHandler = async (payload) => {
	const {page_state} = PayloadSchema.parse(payload);
	const next = await getFeedSuggestionService().backfillRanking(page_state);
	if (next !== null) await getWorkerService().addJob('backfillFeedSuggestionRanking', {page_state: next});
};

export default backfillFeedSuggestionRanking;
