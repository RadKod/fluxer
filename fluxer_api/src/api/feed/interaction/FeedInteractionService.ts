// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {
	type FeedCommentReplyRow,
	type FeedCommentRow,
	type FeedPostRow,
	isPublicFeedPost,
} from '@app/api/database/types/FeedTypes';
import {PUBLIC_COMMENTS_PER_ACCOUNT} from '@app/api/feed/discover/FeedDiscoverRules';
import {isFeedContentVisible} from '@app/api/feed/FeedContentVisibility';
import {type FeedRepository, feedDayAt} from '@app/api/feed/FeedRepository';
import {
	FEED_COMMENT_COUNT_COUNTER,
	FEED_COMMENT_REPLY_COUNT_COUNTER,
	FEED_LIKE_COUNT_COUNTER,
	FEED_VIEW_COUNT_COUNTER,
	replyCounterId,
} from '@app/api/feed/interaction/FeedInteractionCounters';
import type {FeedInteractionRepository} from '@app/api/feed/interaction/FeedInteractionRepository';
import {FeedPollService} from '@app/api/feed/interaction/FeedPollService';
import type {FeedNotificationService} from '@app/api/feed/notification/FeedNotificationService';
import {contentModerationService} from '@app/api/infrastructure/ContentModerationService';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {resolveLimitSafe} from '@app/api/limits/LimitConfigUtils';
import {createLimitMatchContext} from '@app/api/limits/LimitMatchContextBuilder';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {User} from '@app/api/models/User';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import type {LimitKey} from '@fluxer/constants/src/LimitConfigMetadata';
import {MaxFeedCommentsError} from '@fluxer/errors/src/domains/content/MaxFeedCommentsError';
import {UnknownFeedCommentError} from '@fluxer/errors/src/domains/content/UnknownFeedCommentError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {DEFAULT_RESTRICTED_LIMITS} from '@fluxer/limits/src/LimitDefaults';
import type {FeedCommentResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import {makeBucket} from '@fluxer/snowflake/src/SnowflakeBuckets';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

// No feed post predates Micup v2's feed (September 2026), so no like sits in an earlier feed_likes_by_user day.
const FEED_FIRST_DAY = feedDayAt(Date.UTC(2026, 8, 1));
const LIFECYCLE_PAGE_SIZE = 500;
const LIFECYCLE_CONCURRENCY = 16;

interface FeedInteractionServiceDeps {
	repository: FeedInteractionRepository;
	feedRepository: FeedRepository;
	kvCounterService: KVCounterService;
	workerService: IWorkerService<WorkerTaskName>;
	snowflakeService: ISnowflakeService;
	userCacheService: UserCacheService;
	limitConfigService: LimitConfigService;
	notificationService: FeedNotificationService;
}

export interface FeedPostCounts {
	like_count: number;
	comment_count: number;
	poll_votes: Array<number> | null;
	// null while feature_feed_views is 0 (not read at all).
	view_count: number | null;
}

// Likes, comments, one level of replies, poll votes (polls) and their KV counters. Access (feature_feed, the
// post's profile rule and blocks both ways) is checked by the controller. A like or a comment deletion is serialized per
// (post, account) or (post, comment) by a KV lock and a read under it: feed_post_likes is 16 partitions of a possibly
// viral post, so no LWT there. A reply deletion takes its comment's lock, so it never races the comment's own removal.
// The counter moves only when this call's own write or delete happened. comment_count counts comments and replies.
export class FeedInteractionService {
	readonly polls: FeedPollService;

	constructor(readonly deps: FeedInteractionServiceDeps) {
		this.polls = new FeedPollService({repository: deps.repository, kvCounterService: deps.kvCounterService});
	}

	/** Whether this call created the like; liking again changes nothing. */
	async likePost(userId: UserID, post: Pick<FeedPostRow, 'post_id' | 'author_id'>): Promise<boolean> {
		const {repository, kvCounterService} = this.deps;
		const postKey = post.post_id.toString();
		const created = await kvCounterService.withSubjectLock(
			FEED_LIKE_COUNT_COUNTER,
			postKey,
			userId.toString(),
			async () => {
				if (await repository.hasLike(userId, post.post_id)) return false;
				await repository.putLike(userId, post.post_id, new Date());
				await kvCounterService.add(FEED_LIKE_COUNT_COUNTER, postKey, 1);
				return true;
			},
		);
		if (created) {
			await this.deps.notificationService.record({
				recipientId: post.author_id,
				actorId: userId,
				type: 'post_like',
				postId: post.post_id,
			});
		}
		return created;
	}

	/** Whether this call removed the like. */
	async unlikePost(userId: UserID, postId: bigint): Promise<boolean> {
		const {repository, kvCounterService} = this.deps;
		const postKey = postId.toString();
		return kvCounterService.withSubjectLock(FEED_LIKE_COUNT_COUNTER, postKey, userId.toString(), async () => {
			if (!(await repository.hasLike(userId, postId))) return false;
			await repository.deleteLike(userId, postId);
			await kvCounterService.add(FEED_LIKE_COUNT_COUNTER, postKey, -1);
			return true;
		});
	}

	async listLikers(
		postId: bigint,
		options: {after?: UserID; limit: number},
		requestCache: RequestCache,
	): Promise<Array<UserPartialResponse>> {
		const userIds = await this.deps.repository.listLikerIds(postId, options);
		const users = await this.deps.userCacheService.getUserPartialResponses(userIds, requestCache);
		return userIds.flatMap((userId) => users.get(userId) ?? []);
	}

	/**
	 * Adds a comment after the message content checks. On a public post of another author an account writes at most 20
	 * comments (strangers could otherwise fill max_comments_per_post for everyone); the answer is 429 until
	 * the count resets. max_comments_per_post is reserved on the counter first, so racing comments never pass it.
	 */
	async createComment(
		params: {user: User; post: Pick<FeedPostRow, 'post_id' | 'author_id' | 'flags'>; content: string},
		requestCache: RequestCache,
	): Promise<FeedCommentResponse> {
		const {user, post, content} = params;
		scanFeedText(user, content);
		await this.takePublicCommentAllowance(user, post);
		const commentId = await this.deps.snowflakeService.generate();
		const row: FeedCommentRow = {
			post_id: post.post_id,
			bucket: makeBucket(commentId),
			comment_id: commentId,
			author_id: user.id,
			content,
			edited_at: null,
		};
		await this.reserveComment(user, post.post_id, () => this.deps.repository.createComment(row));
		await this.deps.notificationService.record({
			recipientId: post.author_id,
			actorId: user.id,
			type: 'post_comment',
			postId: post.post_id,
			commentId,
		});
		const [response] = await this.toCommentResponses([row], requestCache);
		if (!response) throw new UnknownFeedCommentError();
		return response;
	}

	/**
	 * Adds a reply to a top-level comment (a reply ID is no comment, so a reply to a reply is 404). It shares the
	 * comment rules: the content checks, the stranger allowance of 20 a post and max_comments_per_post. The comment
	 * author hears of it only while feature_feed_reply_notifications is on. It runs under the comment's lock, as
	 * removeComment does, so a reply racing the comment's removal answers 404 instead of leaving an orphan, a count and
	 * a notification behind; the notification itself is recorded after the lock. TEMPORARY: replies to one comment
	 * are written one at a time (a few KV calls and one batch, some 100 a second); path: a shared lock for writers that
	 * only removal takes exclusively; trigger: ResourceLocked answers on the reply route or its p99 over 1 s.
	 */
	async createReply(
		params: {
			user: User;
			post: Pick<FeedPostRow, 'post_id' | 'author_id' | 'flags'>;
			commentId: bigint;
			content: string;
		},
		requestCache: RequestCache,
	): Promise<FeedCommentResponse> {
		const {user, post, commentId, content} = params;
		const {repository, kvCounterService} = this.deps;
		scanFeedText(user, content);
		const replyId = await this.deps.snowflakeService.generate();
		const row: FeedCommentReplyRow = {
			post_id: post.post_id,
			comment_id: commentId,
			bucket: makeBucket(replyId),
			reply_id: replyId,
			author_id: user.id,
			content,
			edited_at: null,
		};
		const parent = await kvCounterService.withSubjectLock(
			FEED_COMMENT_COUNT_COUNTER,
			post.post_id.toString(),
			commentId.toString(),
			async () => {
				// Checked before the allowance and the reservation, so a missing comment uses up neither.
				const parent = await repository.getComment(post.post_id, commentId);
				if (!parent) {
					throw new UnknownFeedCommentError();
				}
				await this.takePublicCommentAllowance(user, post);
				await this.reserveComment(user, post.post_id, () => repository.createReply(row));
				await kvCounterService.add(FEED_COMMENT_REPLY_COUNT_COUNTER, replyCounterId(post.post_id, commentId), 1);
				return parent;
			},
		);
		if (this.instanceLimit('feature_feed_reply_notifications') !== 0) {
			await this.deps.notificationService.record({
				recipientId: parent.author_id,
				actorId: user.id,
				type: 'comment_reply',
				postId: post.post_id,
				commentId,
			});
		}
		const [response] = await this.toReplyResponses([row], requestCache);
		if (!response) throw new UnknownFeedCommentError();
		return response;
	}

	async listComments(
		postId: bigint,
		options: {before?: bigint; limit: number},
		requestCache: RequestCache,
	): Promise<Array<FeedCommentResponse>> {
		return (await this.listCommentsPage(postId, options, requestCache)).entries;
	}

	/** One page of a comment's replies, newest first. */
	async listReplies(
		postId: bigint,
		commentId: bigint,
		options: {before?: bigint; limit: number},
		requestCache: RequestCache,
	): Promise<Array<FeedCommentResponse>> {
		return (await this.listRepliesPage(postId, commentId, options, requestCache)).entries;
	}

	async listCommentsPage(
		postId: bigint,
		options: {before?: bigint; limit: number},
		requestCache: RequestCache,
	): Promise<{entries: Array<FeedCommentResponse>; nextCursor: bigint | undefined}> {
		const rows = await this.deps.repository.listComments(postId, options);
		return {
			entries: await this.toCommentResponses(rows, requestCache),
			nextCursor: rows.length < options.limit ? undefined : rows.at(-1)?.comment_id,
		};
	}

	async listRepliesPage(
		postId: bigint,
		commentId: bigint,
		options: {before?: bigint; limit: number},
		requestCache: RequestCache,
	): Promise<{entries: Array<FeedCommentResponse>; nextCursor: bigint | undefined}> {
		const rows = await this.deps.repository.listReplies(postId, commentId, options);
		return {
			entries: await this.toReplyResponses(rows, requestCache),
			nextCursor: rows.length < options.limit ? undefined : rows.at(-1)?.reply_id,
		};
	}

	async isCommentContentVisible(authorId: UserID, contentId: bigint, requestCache: RequestCache): Promise<boolean> {
		const cutoffs = await this.deps.userCacheService.getContentHiddenSince([authorId], requestCache);
		return isFeedContentVisible(cutoffs, authorId, contentId);
	}

	async getComment(postId: bigint, commentId: bigint): Promise<FeedCommentRow | null> {
		return this.deps.repository.getComment(postId, commentId);
	}

	async getReply(postId: bigint, commentId: bigint, replyId: bigint): Promise<FeedCommentReplyRow | null> {
		return this.deps.repository.getReply(postId, commentId, replyId);
	}

	/** The comment's author and the post's author may delete it. */
	async deleteComment(
		userId: UserID,
		post: Pick<FeedPostRow, 'post_id' | 'author_id'>,
		commentId: bigint,
	): Promise<void> {
		const comment = await this.deps.repository.getComment(post.post_id, commentId);
		if (!comment) {
			throw new UnknownFeedCommentError();
		}
		if (comment.author_id !== userId && post.author_id !== userId) {
			throw new MissingPermissionsError();
		}
		await this.removeComment(comment);
	}

	/** The reply's author and the post's author may delete it. */
	async deleteReply(
		userId: UserID,
		post: Pick<FeedPostRow, 'post_id' | 'author_id'>,
		commentId: bigint,
		replyId: bigint,
	): Promise<void> {
		const reply = await this.deps.repository.getReply(post.post_id, commentId, replyId);
		if (!reply) {
			throw new UnknownFeedCommentError();
		}
		if (reply.author_id !== userId && post.author_id !== userId) {
			throw new MissingPermissionsError();
		}
		await this.removeReply(reply);
	}

	/**
	 * like_count, comment_count, poll votes and, while feature_feed_views is on, view_count for a page of posts,
	 * viewer-free: three or four KV reads, the rows as fallback.
	 * TEMPORARY: the view read is one more MGET per page; path: a 5 s in-process count cache, or the buffered
	 * difference plus the row; trigger: cmdstat_mget twice the pre-flag baseline, or KV p99 above 5 ms.
	 */
	async getPostCounts(rows: Array<FeedPostRow>): Promise<Array<FeedPostCounts>> {
		if (rows.length === 0) return [];
		const {kvCounterService} = this.deps;
		const ids = rows.map((row) => row.post_id.toString());
		const [likes, comments, pollVotes, views] = await Promise.all([
			kvCounterService.getMany(
				FEED_LIKE_COUNT_COUNTER,
				ids,
				rows.map((row) => row.like_count ?? 0),
			),
			kvCounterService.getMany(
				FEED_COMMENT_COUNT_COUNTER,
				ids,
				rows.map((row) => row.comment_count ?? 0),
			),
			this.polls.getCounts(rows),
			this.viewsEnabled()
				? kvCounterService.getMany(
						FEED_VIEW_COUNT_COUNTER,
						ids,
						rows.map((row) => Number(row.view_count ?? 0n)),
					)
				: null,
		]);
		return rows.map((_, index) => ({
			like_count: Math.max(0, likes[index]!),
			comment_count: Math.max(0, comments[index]!),
			poll_votes: pollVotes[index]!,
			view_count: views ? Math.max(0, views[index]!) : null,
		}));
	}

	/** feature_feed_views, instance-wide (E3): 0 hides the counts and closes POST /feed/views. */
	viewsEnabled(): boolean {
		return this.instanceLimit('feature_feed_views') !== 0;
	}

	/** The viewer's part of a page: which posts they like and their poll votes (1-3 Cassandra partitions each). */
	async getViewerStates(
		viewerId: UserID,
		postIds: Array<bigint>,
		pollPostIds: Array<bigint>,
	): Promise<{liked: Set<bigint>; pollVotes: Map<bigint, number>}> {
		const {repository} = this.deps;
		const [liked, pollVotes] = await Promise.all([
			postIds.length === 0 ? new Set<bigint>() : repository.listLikedPostIds(viewerId, postIds),
			pollPostIds.length === 0 ? new Map<bigint, number>() : repository.listPollVotes(viewerId, pollPostIds),
		]);
		return {liked, pollVotes};
	}

	/**
	 * Account deletion (lifecycle lane, retried until done): every like, poll vote and comment of the account, with the
	 * counters of their posts. Rerunning finds only what an earlier run left.
	 */
	async deleteUserInteractions(userId: UserID): Promise<void> {
		const {repository} = this.deps;
		for (const day of likeDays()) {
			for (;;) {
				const likes = await repository.listUserLikes(userId, day, {limit: LIFECYCLE_PAGE_SIZE});
				if (likes.length === 0) break;
				await mapWithConcurrency(likes, LIFECYCLE_CONCURRENCY, async ({post_id}) => this.unlikePost(userId, post_id));
			}
			for (;;) {
				const votes = await repository.listUserPollVotes(userId, day, {limit: LIFECYCLE_PAGE_SIZE});
				if (votes.length === 0) break;
				await mapWithConcurrency(votes, LIFECYCLE_CONCURRENCY, async ({post_id}) =>
					this.polls.removeVote(userId, post_id),
				);
			}
		}
		for (const bucket of commentBuckets(userId)) {
			for (;;) {
				const index = await repository.listAuthorComments(userId, bucket, {limit: LIFECYCLE_PAGE_SIZE});
				if (index.length === 0) break;
				await mapWithConcurrency(index, LIFECYCLE_CONCURRENCY, async ({post_id, comment_id, parent_id}) => {
					await (parent_id == null
						? this.removeComment({post_id, comment_id, author_id: userId})
						: this.removeReply({post_id, comment_id: parent_id, reply_id: comment_id, author_id: userId}));
					await repository.deleteAuthorCommentIndex(userId, comment_id);
				});
			}
		}
	}

	/**
	 * The data export's comments (replies among them, with parent_id), likes and poll votes, newest first; poll_votes only
	 * when the account has voted.
	 */
	async exportUserInteractions(userId: UserID): Promise<{
		comments: Array<ExportedComment>;
		likes: Array<{post_id: string; liked_at: string}>;
		poll_votes?: Array<{post_id: string; option: number; voted_at: string}>;
	}> {
		const {repository} = this.deps;
		const comments: Array<ExportedComment> = [];
		for (const bucket of commentBuckets(userId).reverse()) {
			let before: bigint | undefined;
			for (;;) {
				const index = await repository.listAuthorComments(userId, bucket, {before, limit: LIFECYCLE_PAGE_SIZE});
				if (index.length === 0) break;
				const rows = await mapWithConcurrency(
					index,
					LIFECYCLE_CONCURRENCY,
					async ({post_id, comment_id, parent_id}): Promise<ExportedComment | null> => {
						if (parent_id == null) {
							const row = await repository.getComment(post_id, comment_id);
							return row && exportedComment(row.comment_id, row);
						}
						const row = await repository.getReply(post_id, parent_id, comment_id);
						return row && {...exportedComment(row.reply_id, row), parent_id: parent_id.toString()};
					},
				);
				for (const row of rows) {
					if (row) comments.push(row);
				}
				before = index.at(-1)!.comment_id;
			}
		}
		const likes: Array<{post_id: string; liked_at: string}> = [];
		for (const day of likeDays().reverse()) {
			let before: bigint | undefined;
			for (;;) {
				const page = await repository.listUserLikes(userId, day, {before, limit: LIFECYCLE_PAGE_SIZE});
				if (page.length === 0) break;
				likes.push(...page.map((row) => ({post_id: row.post_id.toString(), liked_at: row.liked_at.toISOString()})));
				before = page.at(-1)!.post_id;
			}
		}
		const pollVotes: Array<{post_id: string; option: number; voted_at: string}> = [];
		for (const day of likeDays().reverse()) {
			let before: bigint | undefined;
			for (;;) {
				const page = await repository.listUserPollVotes(userId, day, {before, limit: LIFECYCLE_PAGE_SIZE});
				if (page.length === 0) break;
				pollVotes.push(
					...page.map((row) => ({
						post_id: row.post_id.toString(),
						option: row.option_index,
						voted_at: row.voted_at.toISOString(),
					})),
				);
				before = page.at(-1)!.post_id;
			}
		}
		// Absent for accounts that never voted, so their exports keep the shape they had before polls.
		return pollVotes.length > 0 ? {comments, likes, poll_votes: pollVotes} : {comments, likes};
	}

	/**
	 * Removes a comment for its author, the post's author, a moderator or account deletion, and its replies with
	 * it: comment_count drops by 1 + the reply count. The replies go first, so a retry after a failure still finds
	 * the comment and repeats the whole removal. Idempotent.
	 */
	async removeComment(comment: Pick<FeedCommentRow, 'post_id' | 'comment_id' | 'author_id'>): Promise<void> {
		const {repository, kvCounterService} = this.deps;
		const postKey = comment.post_id.toString();
		await kvCounterService.withSubjectLock(
			FEED_COMMENT_COUNT_COUNTER,
			postKey,
			comment.comment_id.toString(),
			async () => {
				if (!(await repository.getComment(comment.post_id, comment.comment_id))) return;
				const replies = await kvCounterService.get(
					FEED_COMMENT_REPLY_COUNT_COUNTER,
					replyCounterId(comment.post_id, comment.comment_id),
				);
				await repository.deleteCommentReplies(comment.post_id, comment.comment_id);
				await repository.deleteComment(comment);
				await kvCounterService.add(FEED_COMMENT_COUNT_COUNTER, postKey, -(1 + Math.max(0, replies)));
			},
		);
	}

	/**
	 * Removes a reply for its author, the post's author, a moderator or account deletion. It holds its comment's lock, so
	 * a comment removal that already took the reply leaves nothing to count twice. Idempotent.
	 */
	async removeReply(
		reply: Pick<FeedCommentReplyRow, 'post_id' | 'comment_id' | 'reply_id' | 'author_id'>,
	): Promise<void> {
		const {repository, kvCounterService} = this.deps;
		const postKey = reply.post_id.toString();
		await kvCounterService.withSubjectLock(
			FEED_COMMENT_COUNT_COUNTER,
			postKey,
			reply.comment_id.toString(),
			async () => {
				if (!(await repository.getReply(reply.post_id, reply.comment_id, reply.reply_id))) return;
				await repository.deleteReply(reply);
				await kvCounterService.add(FEED_COMMENT_COUNT_COUNTER, postKey, -1);
				await kvCounterService.add(
					FEED_COMMENT_REPLY_COUNT_COUNTER,
					replyCounterId(reply.post_id, reply.comment_id),
					-1,
				);
			},
		);
	}

	/**
	 * On a public post of another author an account writes at most 20 comments and replies together; the answer is 429 until the count resets.
	 */
	private async takePublicCommentAllowance(
		user: User,
		post: Pick<FeedPostRow, 'post_id' | 'author_id' | 'flags'>,
	): Promise<void> {
		const {repository} = this.deps;
		if (
			!isPublicFeedPost(post) ||
			post.author_id === user.id ||
			(await repository.countPublicComment(post.post_id, user.id)) <= PUBLIC_COMMENTS_PER_ACCOUNT
		) {
			return;
		}
		const retryAfter = await repository.publicCommentsResetSeconds(post.post_id, user.id);
		throw new RateLimitError({
			retryAfter,
			limit: PUBLIC_COMMENTS_PER_ACCOUNT,
			resetTime: new Date(Date.now() + retryAfter * 1000),
			scope: 'user',
		});
	}

	/** Reserves one of max_comments_per_post on comment_count before `write`, and gives it back if the write fails. */
	private async reserveComment(user: User, postId: bigint, write: () => Promise<void>): Promise<void> {
		const {kvCounterService} = this.deps;
		const postKey = postId.toString();
		const maxComments = resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user}),
			'max_comments_per_post',
			DEFAULT_RESTRICTED_LIMITS.max_comments_per_post,
		);
		if ((await kvCounterService.add(FEED_COMMENT_COUNT_COUNTER, postKey, 1)) > maxComments) {
			await kvCounterService.add(FEED_COMMENT_COUNT_COUNTER, postKey, -1);
			throw new MaxFeedCommentsError(maxComments);
		}
		try {
			await write();
		} catch (error) {
			await kvCounterService.add(FEED_COMMENT_COUNT_COUNTER, postKey, -1);
			throw error;
		}
	}

	/** An instance-wide key, read from the default rule. */
	private instanceLimit(key: LimitKey): number {
		return resolveLimitSafe(
			this.deps.limitConfigService.getConfigSnapshot(),
			createLimitMatchContext({user: null}),
			key,
			DEFAULT_RESTRICTED_LIMITS[key],
		);
	}

	/** Top-level comments with their reply counts: one KV read for the page, the rows' reply_count as fallback. */
	private async toCommentResponses(
		rows: Array<FeedCommentRow>,
		requestCache: RequestCache,
	): Promise<Array<FeedCommentResponse>> {
		const [authors, replyCounts, cutoffs] = await Promise.all([
			this.authorsOf(rows, requestCache),
			rows.length === 0
				? []
				: this.deps.kvCounterService.getMany(
						FEED_COMMENT_REPLY_COUNT_COUNTER,
						rows.map((row) => replyCounterId(row.post_id, row.comment_id)),
						rows.map((row) => row.reply_count ?? 0),
					),
			this.deps.userCacheService.getContentHiddenSince(
				rows.map((row) => row.author_id),
				requestCache,
			),
		]);
		return rows.flatMap((row, index) => {
			const author = authors.get(row.author_id);
			if (!author || !isFeedContentVisible(cutoffs, row.author_id, row.comment_id)) return [];
			return [
				{
					id: row.comment_id.toString(),
					post_id: row.post_id.toString(),
					author,
					content: row.content,
					edited_at: row.edited_at?.toISOString() ?? null,
					parent_id: null,
					reply_count: Math.max(0, replyCounts[index]!),
				},
			];
		});
	}

	private async toReplyResponses(
		rows: Array<FeedCommentReplyRow>,
		requestCache: RequestCache,
	): Promise<Array<FeedCommentResponse>> {
		const [authors, cutoffs] = await Promise.all([
			this.authorsOf(rows, requestCache),
			this.deps.userCacheService.getContentHiddenSince(
				rows.map((row) => row.author_id),
				requestCache,
			),
		]);
		return rows.flatMap((row) => {
			const author = authors.get(row.author_id);
			if (!author || !isFeedContentVisible(cutoffs, row.author_id, row.reply_id)) return [];
			return [
				{
					id: row.reply_id.toString(),
					post_id: row.post_id.toString(),
					author,
					content: row.content,
					edited_at: row.edited_at?.toISOString() ?? null,
					parent_id: row.comment_id.toString(),
				},
			];
		});
	}

	private async authorsOf(
		rows: Array<{author_id: UserID}>,
		requestCache: RequestCache,
	): Promise<Map<UserID, UserPartialResponse>> {
		return this.deps.userCacheService.getUserPartialResponses(
			[...new Set(rows.map((row) => row.author_id))],
			requestCache,
		);
	}
}

interface ExportedComment {
	id: string;
	post_id: string;
	parent_id?: string;
	content: string;
	created_at: string;
}

function exportedComment(id: bigint, row: {post_id: bigint; content: string}): ExportedComment {
	return {
		id: id.toString(),
		post_id: row.post_id.toString(),
		content: row.content,
		created_at: snowflakeToDate(id).toISOString(),
	};
}

function scanFeedText(user: User, content: string): void {
	contentModerationService.scanText(content, {
		userId: user.id,
		guildId: null,
		channelId: null,
		messageId: null,
		surface: 'message_content',
	});
}

/**
 * Every feed_likes_by_user (and feed_poll_votes_by_user) day a like or a vote can sit in, oldest first.
 * TEMPORARY: two partition reads per day since the feed started (likes and poll votes, 730 a year) for each account
 * deletion and export; keep a per-account list of liked and voted days once that passes a few seconds of lifecycle work.
 */
function likeDays(): Array<number> {
	const today = feedDayAt(Date.now()) + 1;
	return Array.from({length: today - FEED_FIRST_DAY + 1}, (_, index) => FEED_FIRST_DAY + index);
}

/** Every author index bucket an account's comments can sit in, oldest first (one past today for clock skew). */
function commentBuckets(userId: UserID): Array<number> {
	const first = makeBucket(userId);
	return Array.from({length: makeBucket(null) + 2 - first}, (_, index) => first + index);
}
