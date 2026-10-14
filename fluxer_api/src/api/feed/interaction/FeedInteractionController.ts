// SPDX-License-Identifier: AGPL-3.0-or-later

import {requireEmailVerified} from '@app/api/auth/EmailVerificationUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {type FeedPostRow, isPublicFeedPost} from '@app/api/database/types/FeedTypes';
import {isPublicCommenterEligible} from '@app/api/feed/discover/FeedDiscoverRules';
import {
	FeedEnabled,
	requirePostAccess,
	requirePostContentVisible,
	requirePostViewAccess,
} from '@app/api/feed/FeedPostController';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import type {User} from '@app/api/models/User';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {UnknownFeedCommentError} from '@fluxer/errors/src/domains/content/UnknownFeedCommentError';
import {UnknownFeedPostError} from '@fluxer/errors/src/domains/content/UnknownFeedPostError';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {
	FeedCommentCreateRequest,
	FeedCommentsQuery,
	FeedLikersQuery,
	FeedPollVoteRequest,
	FeedPostIdCommentIdParam,
	FeedPostIdCommentIdReplyIdParam,
	FeedPostIdParam,
} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import {
	FeedCommentListResponse,
	FeedCommentResponse,
	FeedPostLikersResponse,
	FeedPostResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {Context} from 'hono';

async function loadPost(ctx: Context<HonoEnv>, postId: bigint): Promise<FeedPostRow> {
	const post = await ctx.get('feedTimelineService').getPost(postId);
	if (!post) {
		throw new UnknownFeedPostError();
	}
	return post;
}

// Liking, commenting, voting and reading comments need the same access as reading the post (requirePostViewAccess); the
// likers list keeps the author's profile rule even on a public post. A block either way answers 404 like the post
// itself.
async function loadAccessiblePost(
	ctx: Context<HonoEnv>,
	postId: bigint,
	rule: 'post' | 'profile' = 'post',
): Promise<FeedPostRow> {
	const post = await loadPost(ctx, postId);
	const notFound = () => new UnknownFeedPostError();
	if (rule === 'profile') await requirePostContentVisible(ctx, post);
	await (rule === 'post'
		? requirePostViewAccess(ctx, post, notFound)
		: requirePostAccess(ctx, post.author_id, notFound));
	return post;
}

// A public post lets strangers in without the author's profile rule; those the rule would refuse need a standing
// account to comment or vote there. Readers with profile access and the author are not affected,
// and the profile check runs only for an account that fails the cheap test. An unverified account is told to verify its
// email.
async function requireStrangerStanding(
	ctx: Context<HonoEnv>,
	post: FeedPostRow,
	hasStanding: (user: User, nowMs: number) => boolean,
): Promise<void> {
	const user = ctx.get('user');
	if (!isPublicFeedPost(post) || user.id === post.author_id || hasStanding(user, Date.now())) return;
	try {
		await requirePostAccess(ctx, post.author_id);
	} catch (error) {
		requireEmailVerified(user);
		throw error;
	}
}

// Strangers reach public posts, so they must not read people who block them (or whom they block) among its comments or
// replies. The client takes an empty page as the end of the list, so up to three pages are read to fill one. The author and readers of a non-public post see every entry.
async function listVisibleComments(
	ctx: Context<HonoEnv>,
	post: FeedPostRow,
	options: {before?: bigint; limit: number},
	list: (options: {
		before?: bigint;
		limit: number;
	}) => Promise<{entries: Array<FeedCommentResponse>; nextCursor: bigint | undefined}>,
): Promise<Array<FeedCommentResponse>> {
	const viewerId = ctx.get('user').id;
	const {limit} = options;
	const filterBlocked = isPublicFeedPost(post) && post.author_id !== viewerId;
	const discover = ctx.get('feedTimelineService').discover;
	let cursor = options.before;
	for (let pages = 0; pages < 3; pages++) {
		const {entries, nextCursor} = await list({before: cursor, limit});
		const blocked = filterBlocked
			? await discover.blockedAmong(
					viewerId,
					entries.map((entry) => entry.author.id),
				)
			: new Set<string>();
		const visible = entries.filter((entry) => !blocked.has(entry.author.id));
		if (visible.length > 0 || nextCursor === undefined) {
			if (nextCursor !== undefined) ctx.header('X-Next-Before', nextCursor.toString());
			return visible;
		}
		cursor = nextCursor;
	}
	if (cursor !== undefined) ctx.header('X-Next-Before', cursor.toString());
	return [];
}

// The Keşfet trend signal (several KV calls) of a comment or a vote is recorded without holding the answer:
// FeedTrendService catches and logs its own failures and never rejects, so `void` drops nothing but the wait. A like and
// its unlike wait for theirs, so a quick unlike never takes back a like whose write has not landed yet.
export function FeedInteractionController(app: HonoApp) {
	app.put(
		'/feed/posts/:post_id/like',
		RateLimitMiddleware(RateLimitConfigs.FEED_POST_LIKE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdParam),
		OpenAPI({
			operationId: 'like_feed_post',
			summary: 'Like feed post',
			description: 'Likes a post; liking it again changes nothing.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const user = ctx.get('user');
			const post = await loadAccessiblePost(ctx, ctx.req.valid('param').post_id);
			if (await ctx.get('feedInteractionService').likePost(user.id, post)) {
				await ctx.get('feedPostService').trend.recordLike(user, post, 1);
			}
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/feed/posts/:post_id/like',
		RateLimitMiddleware(RateLimitConfigs.FEED_POST_UNLIKE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdParam),
		OpenAPI({
			operationId: 'unlike_feed_post',
			summary: 'Unlike feed post',
			description: 'Takes the caller like off a post.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const user = ctx.get('user');
			const post = await loadAccessiblePost(ctx, ctx.req.valid('param').post_id);
			if (await ctx.get('feedInteractionService').unlikePost(user.id, post.post_id)) {
				await ctx.get('feedPostService').trend.recordLike(user, post, -1);
			}
			return ctx.body(null, 204);
		},
	);
	app.put(
		'/feed/posts/:post_id/poll/vote',
		RateLimitMiddleware(RateLimitConfigs.FEED_POLL_VOTE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdParam),
		Validator('json', FeedPollVoteRequest),
		OpenAPI({
			operationId: 'vote_feed_poll',
			summary: 'Vote in a feed poll',
			description:
				'Casts the caller vote for one option. One vote per account, not changeable; the author cannot vote. Returns the post with the results, which readers see only after voting or once the poll ends.',
			responseSchema: FeedPostResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const user = ctx.get('user');
			const post = await loadAccessiblePost(ctx, ctx.req.valid('param').post_id);
			// A stranger's vote needs a verified email (cheap accounts would move the shown results).
			await requireStrangerStanding(ctx, post, (voter) => voter.emailVerified);
			await ctx.get('feedInteractionService').polls.vote(user, post, ctx.req.valid('json').option);
			void ctx.get('feedPostService').trend.recordPollVote(user, post);
			const [response] = await ctx.get('feedTimelineService').toResponses([post], ctx.get('requestCache'), user.id);
			return ctx.json(response);
		},
	);
	app.get(
		'/feed/posts/:post_id/likes',
		RateLimitMiddleware(RateLimitConfigs.FEED_POST_LIKERS),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdParam),
		Validator('query', FeedLikersQuery),
		OpenAPI({
			operationId: 'list_feed_post_likers',
			summary: 'List feed post likers',
			description: 'Returns one page of the accounts that like a post, by ascending user ID.',
			responseSchema: FeedPostLikersResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const post = await loadAccessiblePost(ctx, ctx.req.valid('param').post_id, 'profile');
			const {after, limit} = ctx.req.valid('query');
			return ctx.json(
				await ctx
					.get('feedInteractionService')
					.listLikers(
						post.post_id,
						{after: after === undefined ? undefined : createUserID(after), limit},
						ctx.get('requestCache'),
					),
			);
		},
	);
	app.get(
		'/feed/posts/:post_id/comments',
		RateLimitMiddleware(RateLimitConfigs.FEED_COMMENTS_LIST),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdParam),
		Validator('query', FeedCommentsQuery),
		OpenAPI({
			operationId: 'list_feed_post_comments',
			summary: 'List feed post comments',
			description: 'Returns one page of the comments on a post, newest first.',
			responseSchema: FeedCommentListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const post = await loadAccessiblePost(ctx, ctx.req.valid('param').post_id);
			const interactions = ctx.get('feedInteractionService');
			return ctx.json(
				await listVisibleComments(ctx, post, ctx.req.valid('query'), (options) =>
					interactions.listCommentsPage(post.post_id, options, ctx.get('requestCache')),
				),
			);
		},
	);
	app.post(
		'/feed/posts/:post_id/comments',
		RateLimitMiddleware(RateLimitConfigs.FEED_COMMENT_CREATE),
		RateLimitMiddleware(RateLimitConfigs.FEED_COMMENT_CREATE_DAILY),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdParam),
		Validator('json', FeedCommentCreateRequest),
		OpenAPI({
			operationId: 'create_feed_post_comment',
			summary: 'Comment on feed post',
			description: 'Adds a plain text comment to a post.',
			responseSchema: FeedCommentResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const user = ctx.get('user');
			const post = await loadAccessiblePost(ctx, ctx.req.valid('param').post_id);
			await requireStrangerStanding(ctx, post, isPublicCommenterEligible);
			const {content} = ctx.req.valid('json');
			const comment = await ctx
				.get('feedInteractionService')
				.createComment({user, post, content}, ctx.get('requestCache'));
			void ctx.get('feedPostService').trend.recordComment(user, post);
			return ctx.json(comment);
		},
	);
	app.delete(
		'/feed/posts/:post_id/comments/:comment_id',
		RateLimitMiddleware(RateLimitConfigs.FEED_COMMENT_DELETE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdCommentIdParam),
		OpenAPI({
			operationId: 'delete_feed_post_comment',
			summary: 'Delete feed post comment',
			description: 'Deletes a comment; its author and the post author may delete it.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {post_id, comment_id} = ctx.req.valid('param');
			// No profile check: the authors of the comment and of the post may remove it whatever blocks lie between them.
			const post = await loadPost(ctx, post_id);
			await ctx.get('feedInteractionService').deleteComment(ctx.get('user').id, post, comment_id);
			return ctx.body(null, 204);
		},
	);
	// One level of replies: the routes take a top-level comment ID only, so a reply to a reply answers 404; they
	// share the comment routes' access rules and rate limit buckets.
	app.get(
		'/feed/posts/:post_id/comments/:comment_id/replies',
		RateLimitMiddleware(RateLimitConfigs.FEED_COMMENTS_LIST),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdCommentIdParam),
		Validator('query', FeedCommentsQuery),
		OpenAPI({
			operationId: 'list_feed_comment_replies',
			summary: 'List feed comment replies',
			description: 'Returns one page of the replies to a top-level comment, newest first.',
			responseSchema: FeedCommentListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const {post_id, comment_id} = ctx.req.valid('param');
			const post = await loadAccessiblePost(ctx, post_id);
			const interactions = ctx.get('feedInteractionService');
			const parent = await interactions.getComment(post.post_id, comment_id);
			if (
				!parent ||
				!(await interactions.isCommentContentVisible(parent.author_id, parent.comment_id, ctx.get('requestCache')))
			)
				throw new UnknownFeedCommentError();
			return ctx.json(
				await listVisibleComments(ctx, post, ctx.req.valid('query'), (options) =>
					interactions.listRepliesPage(post.post_id, comment_id, options, ctx.get('requestCache')),
				),
			);
		},
	);
	app.post(
		'/feed/posts/:post_id/comments/:comment_id/replies',
		RateLimitMiddleware(RateLimitConfigs.FEED_COMMENT_CREATE),
		RateLimitMiddleware(RateLimitConfigs.FEED_COMMENT_CREATE_DAILY),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdCommentIdParam),
		Validator('json', FeedCommentCreateRequest),
		OpenAPI({
			operationId: 'create_feed_comment_reply',
			summary: 'Reply to feed comment',
			description:
				'Adds a plain text reply to a top-level comment. Replies count toward the comment limits of the post.',
			responseSchema: FeedCommentResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const user = ctx.get('user');
			const {post_id, comment_id} = ctx.req.valid('param');
			const post = await loadAccessiblePost(ctx, post_id);
			await requireStrangerStanding(ctx, post, isPublicCommenterEligible);
			const interactions = ctx.get('feedInteractionService');
			// A reply reaches the comment's author: a block either way answers 404, as the post itself does.
			const parent = await interactions.getComment(post.post_id, comment_id);
			if (
				!parent ||
				!(await interactions.isCommentContentVisible(parent.author_id, parent.comment_id, ctx.get('requestCache')))
			)
				throw new UnknownFeedCommentError();
			if (parent.author_id !== user.id) {
				try {
					await ctx.get('followService').assertNotBlocked(user.id, parent.author_id);
				} catch (error) {
					throw error instanceof MissingAccessError ? new UnknownFeedCommentError() : error;
				}
			}
			const {content} = ctx.req.valid('json');
			const reply = await interactions.createReply(
				{user, post, commentId: comment_id, content},
				ctx.get('requestCache'),
			);
			void ctx.get('feedPostService').trend.recordComment(user, post);
			return ctx.json(reply);
		},
	);
	app.delete(
		'/feed/posts/:post_id/comments/:comment_id/replies/:reply_id',
		RateLimitMiddleware(RateLimitConfigs.FEED_COMMENT_DELETE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdCommentIdReplyIdParam),
		OpenAPI({
			operationId: 'delete_feed_comment_reply',
			summary: 'Delete feed comment reply',
			description: 'Deletes a reply; its author and the post author may delete it.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {post_id, comment_id, reply_id} = ctx.req.valid('param');
			// No profile check, as for a comment.
			const post = await loadPost(ctx, post_id);
			await ctx.get('feedInteractionService').deleteReply(ctx.get('user').id, post, comment_id, reply_id);
			return ctx.body(null, 204);
		},
	);
}
