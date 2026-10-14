// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {BatchBuilder, deleteOneOrMany, fetchMany, fetchOne, upsertOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {
	FEED_POLL_VOTE_COUNT_COLUMNS,
	type FeedCommentByAuthorRow,
	type FeedCommentReplyRow,
	type FeedCommentRow,
	type FeedLikeByUserRow,
	type FeedPollVoteByUserRow,
	type FeedPostRow,
} from '@app/api/database/types/FeedTypes';
import {TREND_WINDOW_MS} from '@app/api/feed/discover/FeedDiscoverRules';
import {feedDay, NO_CURSOR} from '@app/api/feed/FeedRepository';
import {
	FeedCommentBuckets,
	FeedCommentReplies,
	FeedCommentReplyBuckets,
	FeedComments,
	FeedCommentsByAuthor,
	FeedLikesByUser,
	FeedPollVotes,
	FeedPollVotesByUser,
	FeedPostLikes,
	FeedPosts,
} from '@app/api/feed/FeedTables';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import {makeBucket, SNOWFLAKE_BUCKET_SIZE_MS} from '@fluxer/snowflake/src/SnowflakeBuckets';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

// feed_post_likes spreads a post's likes over 16 partitions by user_id % 16.
// GEÇİCİ (temporary): 16 fixed shards keep a post under ~6 x 10^6 likes a shard. Trigger: a post passes 10^8 likes.
// Path: a new table with more shards for posts created after a switch time; reads pick the table by post_id.
export const LIKE_SHARDS = 16;
const MAX_BUCKET = 2_147_483_647;
const BUCKET_LIST_PAGE = 32;
const COUNT_PAGE_SIZE = 5000;
const REPLY_PARTITION_DELETE_CONCURRENCY = 16;
// One bucket length: a flag is needed only while its bucket takes comments (the bucket list row goes only with the post).
const COMMENT_BUCKET_FLAG_TTL_SECONDS = Number(SNOWFLAKE_BUCKET_SIZE_MS / 1000n);

export type FeedPostCounterColumn = 'like_count' | 'comment_count' | (typeof FEED_POLL_VOTE_COUNT_COLUMNS)[number];
type FeedPostCounts = Pick<FeedPostRow, 'author_id' | FeedPostCounterColumn | 'view_count'>;

const likeShard = (userId: UserID) => Number(userId % BigInt(LIKE_SHARDS));
const commentBucketFlagKey = (postId: bigint, bucket: number) => `feed:comment_bucket:${postId}:${bucket}`;
const replyBucketFlagKey = (postId: bigint, commentId: bigint, bucket: number) =>
	`feed:reply_bucket:${postId}:${commentId}:${bucket}`;
const publicCommentsKey = (postId: bigint, userId: UserID) => `feed:public_comments:${postId}:${userId}`;
const compareIds = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

const FETCH_LIKE_CQL = FeedLikesByUser.selectCql({
	columns: ['post_id'],
	where: [FeedLikesByUser.where.eq('user_id'), FeedLikesByUser.where.eq('day'), FeedLikesByUser.where.eq('post_id')],
	limit: 1,
});
// One partition per query: the posts of one feed day, a clustering IN within (user_id, day).
const FETCH_LIKED_IN_DAY_CQL = FeedLikesByUser.selectCql({
	columns: ['post_id'],
	where: [
		FeedLikesByUser.where.eq('user_id'),
		FeedLikesByUser.where.eq('day'),
		FeedLikesByUser.where.in('post_id', 'post_ids'),
	],
});
const FETCH_POST_COUNTS_CQL = FeedPosts.selectCql({
	columns: ['author_id', 'like_count', 'comment_count', ...FEED_POLL_VOTE_COUNT_COLUMNS, 'view_count'],
	where: FeedPosts.where.eq('post_id'),
	limit: 1,
});
const FETCH_POLL_VOTE_CQL = FeedPollVotesByUser.selectCql({
	columns: ['option_index'],
	where: [
		FeedPollVotesByUser.where.eq('user_id'),
		FeedPollVotesByUser.where.eq('day'),
		FeedPollVotesByUser.where.eq('post_id'),
	],
	limit: 1,
});
const FETCH_POLL_VOTES_IN_DAY_CQL = FeedPollVotesByUser.selectCql({
	columns: ['post_id', 'option_index'],
	where: [
		FeedPollVotesByUser.where.eq('user_id'),
		FeedPollVotesByUser.where.eq('day'),
		FeedPollVotesByUser.where.in('post_id', 'post_ids'),
	],
});
const FETCH_COMMENT_CQL = FeedComments.selectCql({
	where: [FeedComments.where.eq('post_id'), FeedComments.where.eq('bucket'), FeedComments.where.eq('comment_id')],
	limit: 1,
});
const FETCH_COMMENT_BUCKETS_CQL = FeedCommentBuckets.selectCql({
	columns: ['bucket'],
	where: [FeedCommentBuckets.where.eq('post_id'), FeedCommentBuckets.where.lte('bucket', 'from_bucket')],
	orderBy: {col: 'bucket', direction: 'DESC'},
	limit: BUCKET_LIST_PAGE,
});
// One row per ten days in which the post got a comment.
const FETCH_ALL_COMMENT_BUCKETS_CQL = FeedCommentBuckets.selectCql({
	columns: ['bucket'],
	where: FeedCommentBuckets.where.eq('post_id'),
});
const FETCH_REPLY_CQL = FeedCommentReplies.selectCql({
	where: [
		FeedCommentReplies.where.eq('post_id'),
		FeedCommentReplies.where.eq('comment_id'),
		FeedCommentReplies.where.eq('bucket'),
		FeedCommentReplies.where.eq('reply_id'),
	],
	limit: 1,
});
// Within one comment the bucket list is in clustering order, newest bucket first.
const FETCH_REPLY_BUCKETS_CQL = FeedCommentReplyBuckets.selectCql({
	columns: ['bucket'],
	where: [
		FeedCommentReplyBuckets.where.eq('post_id'),
		FeedCommentReplyBuckets.where.eq('comment_id'),
		FeedCommentReplyBuckets.where.lte('bucket', 'from_bucket'),
	],
	orderBy: {col: 'bucket', direction: 'DESC'},
	limit: BUCKET_LIST_PAGE,
});
// One row per ten days in which the comment got a reply.
const FETCH_ALL_REPLY_BUCKETS_CQL = FeedCommentReplyBuckets.selectCql({
	columns: ['bucket'],
	where: [FeedCommentReplyBuckets.where.eq('post_id'), FeedCommentReplyBuckets.where.eq('comment_id')],
});
// Every (comment, bucket) of a post that holds replies; max_comments_per_post bounds it at 10,000 rows.
const FETCH_POST_REPLY_BUCKETS_CQL = FeedCommentReplyBuckets.selectCql({
	columns: ['comment_id', 'bucket'],
	where: FeedCommentReplyBuckets.where.eq('post_id'),
});
// One range tombstone for a deleted comment's bucket list rows.
const DELETE_COMMENT_REPLY_BUCKETS = FeedCommentReplyBuckets.delete({
	where: [FeedCommentReplyBuckets.where.eq('post_id'), FeedCommentReplyBuckets.where.eq('comment_id')],
});

function likersQuery(limit: number) {
	return FeedPostLikes.select({
		columns: ['user_id'],
		where: [
			FeedPostLikes.where.eq('post_id'),
			FeedPostLikes.where.eq('shard'),
			FeedPostLikes.where.gt('user_id', 'after'),
		],
		orderBy: {col: 'user_id', direction: 'ASC'},
		limit,
	});
}

function votersQuery(limit: number) {
	return FeedPollVotes.select({
		columns: ['user_id', 'option_index'],
		where: [
			FeedPollVotes.where.eq('post_id'),
			FeedPollVotes.where.eq('shard'),
			FeedPollVotes.where.gt('user_id', 'after'),
		],
		orderBy: {col: 'user_id', direction: 'ASC'},
		limit,
	});
}

function userPollVotesQuery(limit: number) {
	return FeedPollVotesByUser.select({
		where: [
			FeedPollVotesByUser.where.eq('user_id'),
			FeedPollVotesByUser.where.eq('day'),
			FeedPollVotesByUser.where.lt('post_id', 'before'),
		],
		orderBy: {col: 'post_id', direction: 'DESC'},
		limit,
	});
}

function userLikesQuery(limit: number) {
	return FeedLikesByUser.select({
		where: [
			FeedLikesByUser.where.eq('user_id'),
			FeedLikesByUser.where.eq('day'),
			FeedLikesByUser.where.lt('post_id', 'before'),
		],
		orderBy: {col: 'post_id', direction: 'DESC'},
		limit,
	});
}

function commentsQuery(limit: number) {
	return FeedComments.select({
		where: [
			FeedComments.where.eq('post_id'),
			FeedComments.where.eq('bucket'),
			FeedComments.where.lt('comment_id', 'before'),
		],
		orderBy: {col: 'comment_id', direction: 'DESC'},
		limit,
	});
}

function repliesQuery(limit: number) {
	return FeedCommentReplies.select({
		where: [
			FeedCommentReplies.where.eq('post_id'),
			FeedCommentReplies.where.eq('comment_id'),
			FeedCommentReplies.where.eq('bucket'),
			FeedCommentReplies.where.lt('reply_id', 'before'),
		],
		orderBy: {col: 'reply_id', direction: 'DESC'},
		limit,
	});
}

function authorCommentsQuery(limit: number) {
	return FeedCommentsByAuthor.select({
		where: [
			FeedCommentsByAuthor.where.eq('author_id'),
			FeedCommentsByAuthor.where.eq('bucket'),
			FeedCommentsByAuthor.where.lt('comment_id', 'before'),
		],
		orderBy: {col: 'comment_id', direction: 'DESC'},
		limit,
	});
}

// feed_post_likes, feed_likes_by_user, feed_poll_votes, feed_poll_votes_by_user, feed_comments, feed_comment_buckets,
// feed_comment_replies, feed_comment_reply_buckets, feed_comments_by_author, the like_count, comment_count and
// poll_vote_count_N and view_count columns of feed_posts and the reply_count column of feed_comments (the KV counter
// bases).
export class FeedInteractionRepository {
	constructor(private readonly kv: IKVProvider) {}

	async hasLike(userId: UserID, postId: bigint): Promise<boolean> {
		return (await fetchOne(FETCH_LIKE_CQL, {user_id: userId, day: feedDay(postId), post_id: postId})) !== null;
	}

	/** The post's row and the liker's row in one logged batch. */
	async putLike(userId: UserID, postId: bigint, likedAt: Date): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(
			FeedPostLikes.upsertAll({post_id: postId, shard: likeShard(userId), user_id: userId, liked_at: likedAt}),
		);
		batch.addPrepared(
			FeedLikesByUser.upsertAll({user_id: userId, day: feedDay(postId), post_id: postId, liked_at: likedAt}),
		);
		await batch.execute();
	}

	async deleteLike(userId: UserID, postId: bigint): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(FeedPostLikes.deleteByPk({post_id: postId, shard: likeShard(userId), user_id: userId}));
		batch.addPrepared(FeedLikesByUser.deleteByPk({user_id: userId, day: feedDay(postId), post_id: postId}));
		await batch.execute();
	}

	/** Which of `postIds` the user likes: one query per feed day of the posts, so a page of posts reads 1-3 partitions. */
	async listLikedPostIds(userId: UserID, postIds: Array<bigint>): Promise<Set<bigint>> {
		const byDay = Map.groupBy(postIds, (postId) => feedDay(postId));
		const pages = await Promise.all(
			Array.from(byDay, ([day, ids]) =>
				fetchMany<{post_id: bigint}>(FETCH_LIKED_IN_DAY_CQL, {user_id: userId, day, post_ids: ids}),
			),
		);
		return new Set(pages.flat().map((row) => row.post_id));
	}

	/** One page of the accounts that like a post, by ascending user ID: the 16 shards read in parallel and merged. */
	async listLikerIds(postId: bigint, options: {after?: UserID; limit: number}): Promise<Array<UserID>> {
		const {limit} = options;
		const after = options.after ?? createUserID(0n);
		const pages = await Promise.all(
			Array.from({length: LIKE_SHARDS}, (_, shard) =>
				fetchMany<{user_id: UserID}>(likersQuery(limit).bind({post_id: postId, shard, after})),
			),
		);
		return pages
			.flat()
			.map((row) => row.user_id)
			.sort(compareIds)
			.slice(0, limit);
	}

	/** Full recount of a post's likes; only the RebuildCounter worker task calls it. */
	async countLikes(postId: bigint): Promise<number> {
		let count = 0;
		for (let shard = 0; shard < LIKE_SHARDS; shard++) {
			let after = createUserID(0n);
			for (;;) {
				const page = await fetchMany<{user_id: UserID}>(
					likersQuery(COUNT_PAGE_SIZE).bind({post_id: postId, shard, after}),
				);
				count += page.length;
				if (page.length < COUNT_PAGE_SIZE) break;
				after = page.at(-1)!.user_id;
			}
		}
		return count;
	}

	/** One page of a user's likes on the posts of one feed day, newest post first. */
	async listUserLikes(
		userId: UserID,
		day: number,
		options: {before?: bigint; limit: number},
	): Promise<Array<FeedLikeByUserRow>> {
		return fetchMany<FeedLikeByUserRow>(
			userLikesQuery(options.limit).bind({user_id: userId, day, before: options.before ?? NO_CURSOR}),
		);
	}

	/** The option the user voted for in the post's poll, or null. */
	async getPollVote(userId: UserID, postId: bigint): Promise<number | null> {
		const row = await fetchOne<{option_index: number}>(FETCH_POLL_VOTE_CQL, {
			user_id: userId,
			day: feedDay(postId),
			post_id: postId,
		});
		return row?.option_index ?? null;
	}

	/**
	 * The poll's row and the voter's row in one logged batch.
	 * TEMPORARY: votes use the likes' 16 fixed shards (LIKE_SHARDS, ~6 x 10^6 votes a shard) and one KV counter
	 * per option (a viral poll at 10 K votes/s is ~2.5 K increments/s on one key, as a viral post's like counter). Trigger:
	 * a poll passes 10^8 votes. Path: a table with more shards for posts created after a switch time, read by post_id.
	 */
	async putPollVote(userId: UserID, postId: bigint, option: number, votedAt: Date): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(
			FeedPollVotes.upsertAll({
				post_id: postId,
				shard: likeShard(userId),
				user_id: userId,
				option_index: option,
				voted_at: votedAt,
			}),
		);
		batch.addPrepared(
			FeedPollVotesByUser.upsertAll({
				user_id: userId,
				day: feedDay(postId),
				post_id: postId,
				option_index: option,
				voted_at: votedAt,
			}),
		);
		await batch.execute();
	}

	async deletePollVote(userId: UserID, postId: bigint): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(FeedPollVotes.deleteByPk({post_id: postId, shard: likeShard(userId), user_id: userId}));
		batch.addPrepared(FeedPollVotesByUser.deleteByPk({user_id: userId, day: feedDay(postId), post_id: postId}));
		await batch.execute();
	}

	/** The user's option in each of `postIds` they voted in: one query per feed day of the posts, as likes. */
	async listPollVotes(userId: UserID, postIds: Array<bigint>): Promise<Map<bigint, number>> {
		const byDay = Map.groupBy(postIds, (postId) => feedDay(postId));
		const pages = await Promise.all(
			Array.from(byDay, ([day, ids]) =>
				fetchMany<{post_id: bigint; option_index: number}>(FETCH_POLL_VOTES_IN_DAY_CQL, {
					user_id: userId,
					day,
					post_ids: ids,
				}),
			),
		);
		return new Map(pages.flat().map((row) => [row.post_id, row.option_index]));
	}

	/** Full recount of one option's votes over the 16 shards; only the RebuildCounter worker task calls it. */
	async countPollVotes(postId: bigint, option: number): Promise<number> {
		let count = 0;
		for (let shard = 0; shard < LIKE_SHARDS; shard++) {
			let after = createUserID(0n);
			for (;;) {
				const page = await fetchMany<{user_id: UserID; option_index: number}>(
					votersQuery(COUNT_PAGE_SIZE).bind({post_id: postId, shard, after}),
				);
				count += page.filter((row) => row.option_index === option).length;
				if (page.length < COUNT_PAGE_SIZE) break;
				after = page.at(-1)!.user_id;
			}
		}
		return count;
	}

	/** One page of a user's poll votes on the posts of one feed day, newest post first. */
	async listUserPollVotes(
		userId: UserID,
		day: number,
		options: {before?: bigint; limit: number},
	): Promise<Array<FeedPollVoteByUserRow>> {
		return fetchMany<FeedPollVoteByUserRow>(
			userPollVotesQuery(options.limit).bind({user_id: userId, day, before: options.before ?? NO_CURSOR}),
		);
	}

	/**
	 * One more comment by an account on a public post of another author; the count lives for the post's
	 * 72 hours, or 72 hours from the first comment once they are (nearly) over. Attempts that passed the checks before it count,
	 * a failed write included (the KV client has no decrement). The key is created with its lifetime (SET NX EX) before
	 * the increment, so it never outlives it.
	 */
	async countPublicComment(postId: bigint, userId: UserID, now = Date.now()): Promise<number> {
		const key = publicCommentsKey(postId, userId);
		const remainingMs = snowflakeToDate(postId).getTime() + TREND_WINDOW_MS - now;
		// Never a lifetime so short that the key could lapse between the two calls and come back without one.
		await this.kv.setnx(key, '0', Math.ceil((remainingMs > 60_000 ? remainingMs : TREND_WINDOW_MS) / 1000));
		return this.kv.incr(key);
	}

	/** Seconds until an account's public comment count on a post resets. */
	async publicCommentsResetSeconds(postId: bigint, userId: UserID): Promise<number> {
		return Math.max(1, await this.kv.ttl(publicCommentsKey(postId, userId)));
	}

	/**
	 * The comment, the author index row and, once per bucket, the post's bucket list entry in one logged batch: a busy
	 * post's bucket list row would otherwise take every comment. The flag goes in after the batch, so a failed write is
	 * retried by the next comment.
	 */
	async createComment(row: FeedCommentRow): Promise<void> {
		const flagKey = commentBucketFlagKey(row.post_id, row.bucket);
		const listed = (await this.kv.get(flagKey)) !== null;
		const batch = new BatchBuilder();
		batch.addPrepared(FeedComments.upsertAll(row));
		if (!listed) {
			batch.addPrepared(
				FeedCommentBuckets.upsertAll({post_id: row.post_id, bucket: row.bucket, updated_at: new Date()}),
			);
		}
		batch.addPrepared(
			FeedCommentsByAuthor.upsertAll({
				author_id: row.author_id,
				bucket: row.bucket,
				comment_id: row.comment_id,
				post_id: row.post_id,
			}),
		);
		await batch.execute();
		if (!listed) await this.kv.setex(flagKey, COMMENT_BUCKET_FLAG_TTL_SECONDS, '1');
	}

	async getComment(postId: bigint, commentId: bigint): Promise<FeedCommentRow | null> {
		return fetchOne<FeedCommentRow>(FETCH_COMMENT_CQL, {
			post_id: postId,
			bucket: makeBucket(commentId),
			comment_id: commentId,
		});
	}

	/** The comment row and its author index row. */
	async deleteComment(row: Pick<FeedCommentRow, 'post_id' | 'comment_id' | 'author_id'>): Promise<void> {
		const bucket = makeBucket(row.comment_id);
		const batch = new BatchBuilder();
		batch.addPrepared(FeedComments.deleteByPk({post_id: row.post_id, bucket, comment_id: row.comment_id}));
		batch.addPrepared(FeedCommentsByAuthor.deleteByPk({author_id: row.author_id, bucket, comment_id: row.comment_id}));
		await batch.execute();
	}

	/**
	 * One page of a post's comments, newest first, walking its ten day buckets back from `before`. A page is short only
	 * when the post has no older comments.
	 */
	async listComments(postId: bigint, options: {before?: bigint; limit: number}): Promise<Array<FeedCommentRow>> {
		const {limit} = options;
		const rows: Array<FeedCommentRow> = [];
		let before = options.before ?? NO_CURSOR;
		let fromBucket = options.before === undefined ? MAX_BUCKET : makeBucket(options.before);
		for (;;) {
			const buckets = await fetchMany<{bucket: number}>(FETCH_COMMENT_BUCKETS_CQL, {
				post_id: postId,
				from_bucket: fromBucket,
			});
			for (const {bucket} of buckets) {
				const page = await fetchMany<FeedCommentRow>(
					commentsQuery(limit - rows.length).bind({post_id: postId, bucket, before}),
				);
				rows.push(...page);
				if (rows.length >= limit) return rows;
				before = NO_CURSOR;
			}
			if (buckets.length < BUCKET_LIST_PAGE) return rows;
			fromBucket = buckets.at(-1)!.bucket - 1;
		}
	}

	/** Full recount of a post's comments and their replies; only the RebuildCounter worker task calls it. */
	async countComments(postId: bigint): Promise<number> {
		let count = 0;
		for (const {bucket} of await fetchMany<{bucket: number}>(FETCH_ALL_COMMENT_BUCKETS_CQL, {post_id: postId})) {
			let before = NO_CURSOR;
			for (;;) {
				const page = await fetchMany<FeedCommentRow>(
					commentsQuery(COUNT_PAGE_SIZE).bind({post_id: postId, bucket, before}),
				);
				count += page.length;
				if (page.length < COUNT_PAGE_SIZE) break;
				before = page.at(-1)!.comment_id;
			}
		}
		const replyBuckets = await fetchMany<{comment_id: bigint; bucket: number}>(FETCH_POST_REPLY_BUCKETS_CQL, {
			post_id: postId,
		});
		for (const {comment_id, bucket} of replyBuckets) {
			count += await this.countReplyPartition(postId, comment_id, bucket);
		}
		return count;
	}

	/**
	 * The reply, its author index row (parent_id = the comment) and, once per bucket, the comment's bucket list entry in
	 * one logged batch, as createComment.
	 */
	async createReply(row: FeedCommentReplyRow): Promise<void> {
		const flagKey = replyBucketFlagKey(row.post_id, row.comment_id, row.bucket);
		const listed = (await this.kv.get(flagKey)) !== null;
		const batch = new BatchBuilder();
		batch.addPrepared(FeedCommentReplies.upsertAll(row));
		if (!listed) {
			batch.addPrepared(
				FeedCommentReplyBuckets.upsertAll({
					post_id: row.post_id,
					comment_id: row.comment_id,
					bucket: row.bucket,
					updated_at: new Date(),
				}),
			);
		}
		batch.addPrepared(
			FeedCommentsByAuthor.upsertAll({
				author_id: row.author_id,
				bucket: row.bucket,
				comment_id: row.reply_id,
				post_id: row.post_id,
				parent_id: row.comment_id,
			}),
		);
		await batch.execute();
		if (!listed) await this.kv.setex(flagKey, COMMENT_BUCKET_FLAG_TTL_SECONDS, '1');
	}

	async getReply(postId: bigint, commentId: bigint, replyId: bigint): Promise<FeedCommentReplyRow | null> {
		return fetchOne<FeedCommentReplyRow>(FETCH_REPLY_CQL, {
			post_id: postId,
			comment_id: commentId,
			bucket: makeBucket(replyId),
			reply_id: replyId,
		});
	}

	/** The reply row and its author index row. */
	async deleteReply(
		row: Pick<FeedCommentReplyRow, 'post_id' | 'comment_id' | 'reply_id' | 'author_id'>,
	): Promise<void> {
		const bucket = makeBucket(row.reply_id);
		const batch = new BatchBuilder();
		batch.addPrepared(
			FeedCommentReplies.deleteByPk({
				post_id: row.post_id,
				comment_id: row.comment_id,
				bucket,
				reply_id: row.reply_id,
			}),
		);
		batch.addPrepared(FeedCommentsByAuthor.deleteByPk({author_id: row.author_id, bucket, comment_id: row.reply_id}));
		await batch.execute();
	}

	/** One page of a comment's replies, newest first, walking its ten day buckets back from `before` (as listComments). */
	async listReplies(
		postId: bigint,
		commentId: bigint,
		options: {before?: bigint; limit: number},
	): Promise<Array<FeedCommentReplyRow>> {
		const {limit} = options;
		const rows: Array<FeedCommentReplyRow> = [];
		let before = options.before ?? NO_CURSOR;
		let fromBucket = options.before === undefined ? MAX_BUCKET : makeBucket(options.before);
		for (;;) {
			const buckets = await fetchMany<{bucket: number}>(FETCH_REPLY_BUCKETS_CQL, {
				post_id: postId,
				comment_id: commentId,
				from_bucket: fromBucket,
			});
			for (const {bucket} of buckets) {
				const page = await fetchMany<FeedCommentReplyRow>(
					repliesQuery(limit - rows.length).bind({post_id: postId, comment_id: commentId, bucket, before}),
				);
				rows.push(...page);
				if (rows.length >= limit) return rows;
				before = NO_CURSOR;
			}
			if (buckets.length < BUCKET_LIST_PAGE) return rows;
			fromBucket = buckets.at(-1)!.bucket - 1;
		}
	}

	/** Full recount of one comment's replies; only the RebuildCounter worker task calls it. */
	async countReplies(postId: bigint, commentId: bigint): Promise<number> {
		let count = 0;
		for (const {bucket} of await this.replyBuckets(postId, commentId)) {
			count += await this.countReplyPartition(postId, commentId, bucket);
		}
		return count;
	}

	/**
	 * A deleted comment's reply partitions (one per ten days of replies), then its bucket list rows and their KV flags,
	 * so a reply that still lands under the comment lists its bucket again and goes with the post. The repliers' author
	 * index rows stay, as a deleted post's commenters' do; account deletion clears them.
	 */
	async deleteCommentReplies(postId: bigint, commentId: bigint): Promise<void> {
		const buckets = await this.replyBuckets(postId, commentId);
		await Promise.all(
			buckets.map(({bucket}) =>
				deleteOneOrMany(FeedCommentReplies.deletePartition({post_id: postId, comment_id: commentId, bucket})),
			),
		);
		await deleteOneOrMany(DELETE_COMMENT_REPLY_BUCKETS.bind({post_id: postId, comment_id: commentId}));
		if (buckets.length > 0) {
			await this.kv.del(...buckets.map(({bucket}) => replyBucketFlagKey(postId, commentId, bucket)));
		}
	}

	/** Writes the reply_count column only (the reply counter's flush checks the comment row first). */
	async setCommentReplyCount(postId: bigint, commentId: bigint, value: number): Promise<void> {
		await upsertOne(
			FeedComments.patchByPk(
				{post_id: postId, bucket: makeBucket(commentId), comment_id: commentId},
				{reply_count: Db.set(value)},
			),
		);
	}

	private async replyBuckets(postId: bigint, commentId: bigint): Promise<Array<{bucket: number}>> {
		return fetchMany<{bucket: number}>(FETCH_ALL_REPLY_BUCKETS_CQL, {post_id: postId, comment_id: commentId});
	}

	private async countReplyPartition(postId: bigint, commentId: bigint, bucket: number): Promise<number> {
		let count = 0;
		let before = NO_CURSOR;
		for (;;) {
			const page = await fetchMany<FeedCommentReplyRow>(
				repliesQuery(COUNT_PAGE_SIZE).bind({post_id: postId, comment_id: commentId, bucket, before}),
			);
			count += page.length;
			if (page.length < COUNT_PAGE_SIZE) return count;
			before = page.at(-1)!.reply_id;
		}
	}

	/** One page of an author's comments in one ten day bucket, newest first. */
	async listAuthorComments(
		authorId: UserID,
		bucket: number,
		options: {before?: bigint; limit: number},
	): Promise<Array<FeedCommentByAuthorRow>> {
		return fetchMany<FeedCommentByAuthorRow>(
			authorCommentsQuery(options.limit).bind({author_id: authorId, bucket, before: options.before ?? NO_CURSOR}),
		);
	}

	/** An author index row whose comment went with its post. */
	async deleteAuthorCommentIndex(authorId: UserID, commentId: bigint): Promise<void> {
		await deleteOneOrMany(
			FeedCommentsByAuthor.deleteByPk({author_id: authorId, bucket: makeBucket(commentId), comment_id: commentId}),
		);
	}

	/**
	 * A deleted post's likes, poll votes, comments and replies: the 16 like partitions, the 16 vote partitions of a poll,
	 * one partition per comment bucket and one per (comment, reply bucket), then the two bucket lists. The likers'
	 * feed_likes_by_user rows, the voters' feed_poll_votes_by_user rows and the commenters' and repliers' author index
	 * rows stay; account deletion clears them.
	 * TEMPORARY: up to 10,000 reply partitions, 16 at a time, on the request path. Trigger: removePost p99 > 2 s.
	 * Path: a worker job deletes the reply partitions, then the reply bucket list.
	 */
	async deletePostInteractions(postId: bigint, options: {poll?: boolean} = {}): Promise<void> {
		const [buckets, replyBuckets] = await Promise.all([
			fetchMany<{bucket: number}>(FETCH_ALL_COMMENT_BUCKETS_CQL, {post_id: postId}),
			fetchMany<{comment_id: bigint; bucket: number}>(FETCH_POST_REPLY_BUCKETS_CQL, {post_id: postId}),
		]);
		const pollShards = options.poll ? LIKE_SHARDS : 0;
		await Promise.all([
			...Array.from({length: LIKE_SHARDS}, (_, shard) =>
				deleteOneOrMany(FeedPostLikes.deletePartition({post_id: postId, shard})),
			),
			...Array.from({length: pollShards}, (_, shard) =>
				deleteOneOrMany(FeedPollVotes.deletePartition({post_id: postId, shard})),
			),
			...buckets.map(({bucket}) => deleteOneOrMany(FeedComments.deletePartition({post_id: postId, bucket}))),
			mapWithConcurrency(replyBuckets, REPLY_PARTITION_DELETE_CONCURRENCY, async ({comment_id, bucket}) =>
				deleteOneOrMany(FeedCommentReplies.deletePartition({post_id: postId, comment_id, bucket})),
			),
		]);
		await deleteOneOrMany(FeedCommentBuckets.deletePartition({post_id: postId}));
		await deleteOneOrMany(FeedCommentReplyBuckets.deletePartition({post_id: postId}));
	}

	/** The counter columns of a post row as Cassandra holds them (never the 60 s post cache). */
	async getPostCounts(postId: bigint): Promise<FeedPostCounts | null> {
		return fetchOne<FeedPostCounts>(FETCH_POST_COUNTS_CQL, {post_id: postId});
	}

	/** Writes the one counter column only. */
	async setPostCount(postId: bigint, column: FeedPostCounterColumn, value: number): Promise<void> {
		await upsertOne(FeedPosts.patchByPk({post_id: postId}, {[column]: Db.set(value)}));
	}

	/** Writes the view_count column only (bigint, so apart from the int counter columns). */
	async setPostViewCount(postId: bigint, value: bigint): Promise<void> {
		await upsertOne(FeedPosts.patchByPk({post_id: postId}, {view_count: Db.set(value)}));
	}
}
