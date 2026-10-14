// SPDX-License-Identifier: AGPL-3.0-or-later

import {FEED_POLL_VOTE_COUNT_COLUMNS} from '@app/api/database/types/FeedTypes';
import type {
	FeedInteractionRepository,
	FeedPostCounterColumn,
} from '@app/api/feed/interaction/FeedInteractionRepository';
import type {CounterFlusher} from '@app/api/infrastructure/KVCounterService';

export const FEED_LIKE_COUNT_COUNTER = 'feed_post_like_count';
export const FEED_COMMENT_COUNT_COUNTER = 'feed_post_comment_count';
// One counter per poll option: id `<post_id>:<option>`, base in the poll_vote_count_<option> column.
export const FEED_POLL_VOTE_COUNT_COUNTER = 'feed_poll_vote_count';
// One counter per top-level comment: id `<post_id>:<comment_id>`, base in the reply_count column of feed_comments.
export const FEED_COMMENT_REPLY_COUNT_COUNTER = 'feed_comment_reply_count';
export const FEED_VIEW_COUNT_COUNTER = 'feed_post_view_count';
export const FEED_VIEW_DIRTY_SET = 'views';

export const replyCounterId = (postId: bigint, commentId: bigint) => `${postId}:${commentId}`;

type CounterTarget = {postId: bigint; column: FeedPostCounterColumn; option: number};

const postTarget =
	(column: FeedPostCounterColumn) =>
	(id: string): CounterTarget => ({postId: BigInt(id), column, option: 0});

function pollTarget(id: string): CounterTarget {
	const [postId, option] = id.split(':');
	return {postId: BigInt(postId!), column: FEED_POLL_VOTE_COUNT_COLUMNS[Number(option)]!, option: Number(option)};
}

// KV counters with their bases in the like_count, comment_count and poll_vote_count_N columns of feed_posts (and
// reply_count of feed_comments), so a page of posts or comments reads its counts from the rows it already loads when KV
// has none. recount runs only from the RebuildCounter worker task.
export function createFeedInteractionCounterFlushers(repository: FeedInteractionRepository): Array<CounterFlusher> {
	const flusher = (
		namespace: string,
		targetOf: (id: string) => CounterTarget,
		recount: (target: CounterTarget) => Promise<number>,
	): CounterFlusher => ({
		namespace,
		async readBase(id) {
			const {postId, column} = targetOf(id);
			return (await repository.getPostCounts(postId))?.[column] ?? 0;
		},
		async flush(id, value) {
			const {postId, column} = targetOf(id);
			const count = Math.max(0, value);
			const stored = await repository.getPostCounts(postId);
			// A deleted post has no row; writing the column would create a row with only post_id and the count. One
			// written in the instant between this read and a delete has no author_id, and every feed read ignores it.
			if (stored?.author_id == null || stored[column] === count) return;
			await repository.setPostCount(postId, column, count);
		},
		recount: async (id) => recount(targetOf(id)),
	});
	return [
		flusher(FEED_LIKE_COUNT_COUNTER, postTarget('like_count'), ({postId}) => repository.countLikes(postId)),
		flusher(FEED_COMMENT_COUNT_COUNTER, postTarget('comment_count'), ({postId}) => repository.countComments(postId)),
		flusher(FEED_POLL_VOTE_COUNT_COUNTER, pollTarget, ({postId, option}) => repository.countPollVotes(postId, option)),
		replyCountFlusher(repository),
		viewCountFlusher(repository),
	];
}

function replyCountFlusher(repository: FeedInteractionRepository): CounterFlusher {
	const targetOf = (id: string) => {
		const [postId, commentId] = id.split(':');
		return {postId: BigInt(postId!), commentId: BigInt(commentId!)};
	};
	return {
		namespace: FEED_COMMENT_REPLY_COUNT_COUNTER,
		async readBase(id) {
			const {postId, commentId} = targetOf(id);
			return (await repository.getComment(postId, commentId))?.reply_count ?? 0;
		},
		async flush(id, value) {
			const {postId, commentId} = targetOf(id);
			const count = Math.max(0, value);
			const stored = await repository.getComment(postId, commentId);
			// A deleted comment has no row, and writing the column would create one (as the post counters above).
			if (stored?.author_id == null || (stored.reply_count ?? 0) === count) return;
			await repository.setCommentReplyCount(postId, commentId, count);
		},
		recount: async (id) => {
			const {postId, commentId} = targetOf(id);
			return repository.countReplies(postId, commentId);
		},
	};
}

// views of a post, base in feed_posts.view_count (bigint). No recount source: views are never stored
// one by one.
// TEMPORARY: every post viewed keeps its KV counter key (~100 B) until 24 h after its last flush
// (FLUSHED_COUNTER_TTL_SECONDS in KVCounterService); path: a short post-flush TTL per flusher (e.g. 1 h, a CounterFlusher
// field); trigger: the runbook sample, view key count × MEMORY USAGE, reaching used_memory × 0.1.
function viewCountFlusher(repository: FeedInteractionRepository): CounterFlusher {
	return {
		namespace: FEED_VIEW_COUNT_COUNTER,
		dirtySet: FEED_VIEW_DIRTY_SET,
		async readBase(id) {
			return Number((await repository.getPostCounts(BigInt(id)))?.view_count ?? 0n);
		},
		async flush(id, value) {
			const postId = BigInt(id);
			const count = BigInt(Math.max(0, value));
			const stored = await repository.getPostCounts(postId);
			// As the post counters above: a deleted post has no row, and this write would create one.
			if (stored?.author_id == null || (stored.view_count ?? 0n) === count) return;
			await repository.setPostViewCount(postId, count);
		},
		async recount() {
			throw new Error('feed_post_view_count has no recount source; views are not stored one by one');
		},
	};
}
