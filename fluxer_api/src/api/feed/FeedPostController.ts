// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {type FeedPostRow, isPublicFeedPost} from '@app/api/database/types/FeedTypes';
import {isFeedContentVisible} from '@app/api/feed/FeedContentVisibility';
import {opensPublicPostsToStrangers} from '@app/api/feed/FeedTimelineService';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import type {ProfileView} from '@app/api/user/profile/ProfileAccessRules';
import {profileViewer} from '@app/api/user/profile/ProfileViewer';
import {Validator} from '@app/api/Validator';
import {UnknownFeedPostError} from '@fluxer/errors/src/domains/content/UnknownFeedPostError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {requireClientIp} from '@fluxer/ip_utils/src/ClientIp';
import {UserIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {
	FeedAttachmentUploadRequest,
	FeedDiscoverQuery,
	FeedPageQuery,
	FeedPostCreateRequest,
	FeedPostIdParam,
} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import {FeedPostListResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {PresignedAttachmentUploadResponse} from '@fluxer/schema/src/domains/message/AttachmentUploadSchemas';
import type {Context} from 'hono';
import {createMiddleware} from 'hono/factory';

/** The feature_feed kill switch, on every feed route (2a.8 and 2a.9 routes too): 0 answers 403. */
export const FeedEnabled = createMiddleware<HonoEnv>(async (ctx, next) => {
	if (!ctx.get('feedPostService').isFeedEnabled(ctx.get('user'))) {
		throw new FeatureTemporarilyDisabledError();
	}
	await next();
});

/**
 * A user's posts follow the one profile access rule: the full view reads them all; the public view, only where
 * the caller allows it (the posts list), reads those marked public. A block either way refuses them, and so does a
 * disabled or deleted author: posts answer 404 for those and 403 otherwise, the post list 403 for all. Only the posts
 * list spends the daily stranger budget (countStranger).
 */
export async function requirePostAccess(
	ctx: Context<HonoEnv>,
	authorId: UserID,
	blockedError: () => Error = () => new MissingAccessError(),
	{allowPublic = false, countStranger = false}: {allowPublic?: boolean; countStranger?: boolean} = {},
): Promise<ProfileView> {
	const viewer = profileViewer(ctx, {countStranger});
	if (viewer.user.id === authorId) return 'full';
	const access = await ctx.get('userService').accountService.lookupService.resolveProfileAccess({
		userId: viewer.user.id,
		targetId: authorId,
		viewer,
		requestCache: ctx.get('requestCache'),
	});
	if (access.blocked || access.feedHidden) throw blockedError();
	if (access.view === 'full' || (allowPublic && access.view === 'public')) return access.view;
	throw new MissingAccessError();
}

/**
 * Access to one post and what hangs off it (comments, likes, votes, reports). A public post skips the profile view while
 * its author is public now (the bit says the post was shared publicly, the level says it still is) and not a
 * spammer; never a block either way or a disabled or deleted author. No viewer standing and no stranger budget on this
 * branch (today's link rule). Every other post, and the likers list for any post, needs the full view. The author's side
 * comes from the profile side record, not the users and settings rows; the bond is computed only for the full view.
 */
export async function requirePostContentVisible(
	ctx: Context<HonoEnv>,
	post: Pick<FeedPostRow, 'author_id' | 'post_id'>,
): Promise<void> {
	const cutoffs = await ctx.get('userCacheService').getContentHiddenSince([post.author_id], ctx.get('requestCache'));
	if (!isFeedContentVisible(cutoffs, post.author_id, post.post_id)) throw new UnknownFeedPostError();
}

export async function requirePostViewAccess(
	ctx: Context<HonoEnv>,
	post: Pick<FeedPostRow, 'author_id' | 'flags' | 'post_id'>,
	blockedError: () => Error = () => new MissingAccessError(),
): Promise<void> {
	await requirePostContentVisible(ctx, post);
	const viewerId = ctx.get('user').id;
	if (!isPublicFeedPost(post) || viewerId === post.author_id) {
		await requirePostAccess(ctx, post.author_id, blockedError);
		return;
	}
	const lookup = ctx.get('userService').accountService.lookupService;
	const {side, blocked} = await lookup.resolvePublicPostAccess({userId: viewerId, targetId: post.author_id});
	if (blocked || side.publicHidden) throw blockedError();
	if (side.audience === 'everyone' && !side.spammer) return;
	const access = await lookup.resolveProfileAccess({
		userId: viewerId,
		targetId: post.author_id,
		requestCache: ctx.get('requestCache'),
	});
	if (access.view !== 'full') throw new MissingAccessError();
}

export function FeedPostController(app: HonoApp) {
	app.post(
		'/feed/attachments',
		RateLimitMiddleware(RateLimitConfigs.FEED_ATTACHMENT_UPLOAD),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('json', FeedAttachmentUploadRequest),
		OpenAPI({
			operationId: 'request_feed_attachment_uploads',
			summary: 'Request feed media upload URLs',
			description:
				'Returns presigned upload URLs for up to four post images, through the same upload path, size and type policy and scanning as message attachments. Videos are not uploaded here; a video post starts at POST /feed/videos.',
			responseSchema: PresignedAttachmentUploadResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const clientIp = requireClientIp(ctx.req.raw, {
				trustClientIpHeader: Config.proxy.trust_client_ip_header,
				clientIpHeaderName: Config.proxy.client_ip_header,
			});
			return ctx.json({
				attachments: await ctx.get('feedPostService').media.planUploads({
					user: ctx.get('user'),
					clientIp,
					attachments: ctx.req.valid('json').attachments,
				}),
			});
		},
	);
	app.post(
		'/feed/posts',
		RateLimitMiddleware(RateLimitConfigs.FEED_POST_CREATE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('json', FeedPostCreateRequest),
		OpenAPI({
			operationId: 'create_feed_post',
			summary: 'Create feed post',
			description:
				'Publishes a post with text, up to four images or both, up to max_feed_posts_per_day a day; a video post starts at POST /feed/videos instead. Followers see it through their home feed; new posts are not pushed over the gateway.',
			responseSchema: FeedPostResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {content, attachments, poll} = ctx.req.valid('json');
			const user = ctx.get('user');
			// the public bit comes from the author's level, read fresh from their own settings row (a
			// write, not a cache); the request's public field is ignored.
			const isPublic = opensPublicPostsToStrangers(await ctx.get('userRepository').findSettings(user.id), user);
			const post = await ctx.get('feedPostService').createPost({user, content, attachments, isPublic, poll});
			const [response] = await ctx.get('feedTimelineService').toResponses([post], ctx.get('requestCache'), user.id);
			if (!response) throw new UnknownFeedPostError();
			return ctx.json(response);
		},
	);
	app.get(
		'/feed/posts/:post_id',
		RateLimitMiddleware(RateLimitConfigs.FEED_POST_GET),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdParam),
		OpenAPI({
			operationId: 'get_feed_post',
			summary: 'Get feed post',
			description: 'Returns one post. Posts of accounts that block each other are not found.',
			responseSchema: FeedPostResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const post = await ctx.get('feedTimelineService').getPost(ctx.req.valid('param').post_id);
			if (!post) {
				throw new UnknownFeedPostError();
			}
			await requirePostViewAccess(ctx, post, () => new UnknownFeedPostError());
			const [response] = await ctx
				.get('feedTimelineService')
				.toResponses([post], ctx.get('requestCache'), ctx.get('user').id);
			return ctx.json(response);
		},
	);
	app.delete(
		'/feed/posts/:post_id',
		RateLimitMiddleware(RateLimitConfigs.FEED_POST_DELETE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedPostIdParam),
		OpenAPI({
			operationId: 'delete_feed_post',
			summary: 'Delete feed post',
			description: 'Deletes one of the caller posts. Home feeds drop it on their next read.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			await ctx.get('feedPostService').deletePost(ctx.get('user').id, ctx.req.valid('param').post_id);
			return ctx.body(null, 204);
		},
	);
	app.get(
		'/feed/home',
		RateLimitMiddleware(RateLimitConfigs.FEED_HOME),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('query', FeedPageQuery),
		OpenAPI({
			operationId: 'get_feed_home',
			summary: 'Get home feed',
			description:
				'Returns one page of posts from followed accounts and the caller, newest first: the fanned-out home feed merged with large accounts read at request time. The X-Next-Before header, when present, is the before value for the next page; a page can come back short or empty while it is present. An empty page without it is the end of the feed.',
			responseSchema: FeedPostListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const {before, limit} = ctx.req.valid('query');
			const timeline = ctx.get('feedTimelineService');
			const viewerId = ctx.get('user').id;
			const access = ctx.get('userService').accountService.lookupService;
			const {posts, nextBefore} = await timeline.getHome(viewerId, {
				before,
				limit,
				access,
				publicReach: timeline.discover.isEnabledFor(ctx.get('user')),
				viewer: profileViewer(ctx),
				requestCache: ctx.get('requestCache'),
			});
			if (nextBefore !== null) {
				ctx.header('X-Next-Before', nextBefore.toString());
			}
			return ctx.json(await timeline.toResponses(posts, ctx.get('requestCache'), viewerId));
		},
	);
	app.get(
		'/feed/discover',
		RateLimitMiddleware(RateLimitConfigs.FEED_DISCOVER),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('query', FeedDiscoverQuery),
		OpenAPI({
			operationId: 'get_feed_discover',
			summary: 'Get Discover feed',
			description:
				'Returns one page of public posts that drew reactions across the instance lately, best first, refreshed about once a minute. Posts of accounts that block each other are left out. The X-Next-Cursor header, when present, is the cursor for the next page; without it the list has ended.',
			responseSchema: FeedPostListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const user = ctx.get('user');
			const discover = ctx.get('feedTimelineService').discover;
			if (!discover.isEnabledFor(user)) throw new FeatureTemporarilyDisabledError();
			const {cursor, limit} = ctx.req.valid('query');
			const {posts, nextCursor} = await discover.getPage(user.id, {cursor, limit});
			if (nextCursor !== null) ctx.header('X-Next-Cursor', nextCursor);
			return ctx.json(posts);
		},
	);
	app.get(
		'/users/:user_id/posts',
		RateLimitMiddleware(RateLimitConfigs.FEED_USER_POSTS),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', UserIdParam),
		Validator('query', FeedPageQuery),
		OpenAPI({
			operationId: 'list_user_feed_posts',
			summary: 'List user feed posts',
			description:
				'Returns one page of the posts of a user, newest first. A caller who sees the profile only as a public one gets the posts marked public; such a page can come back short or empty while the X-Next-Before header, the before value for the next page, is present.',
			responseSchema: FeedPostListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const authorId = createUserID(ctx.req.valid('param').user_id);
			const view = await requirePostAccess(ctx, authorId, undefined, {allowPublic: true, countStranger: true});
			const {before, limit} = ctx.req.valid('query');
			const timeline = ctx.get('feedTimelineService');
			const {posts, nextBefore} = await timeline.getAuthorPosts(authorId, {
				before,
				limit,
				publicOnly: view === 'public',
			});
			if (nextBefore !== null) ctx.header('X-Next-Before', nextBefore.toString());
			return ctx.json(await timeline.toResponses(posts, ctx.get('requestCache'), ctx.get('user').id));
		},
	);
}
