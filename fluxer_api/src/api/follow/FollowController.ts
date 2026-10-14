// SPDX-License-Identifier: AGPL-3.0-or-later

import {requireEmailVerified} from '@app/api/auth/EmailVerificationUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {DISCOVER_HIDDEN_AUTHOR_FLAGS} from '@app/api/feed/discover/FeedDiscoverRules';
import {opensPublicPostsToStrangers} from '@app/api/feed/FeedTimelineService';
import {hasStrangerFollowStanding, isSuggestableAccount} from '@app/api/feed/suggest/FeedSuggestionService';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {getFollowRepository} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited, isMicupAccountLimited} from '@app/api/user/AccountLimit';
import {profileViewer} from '@app/api/user/profile/ProfileViewer';
import {isUserAdult} from '@app/api/utils/AgeUtils';
import {Validator} from '@app/api/Validator';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {UserIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {
	FollowCreateRequest,
	FollowersQuery,
	FollowingQuery,
} from '@fluxer/schema/src/domains/follow/FollowRequestSchemas';
import {FollowListResponse} from '@fluxer/schema/src/domains/follow/FollowResponseSchemas';
import type {Context} from 'hono';

// a new follow takes the full view, or a stranger's public view with the
// feed on (the view already holds the stranger's standing); an account may follow back one that follows it under
// every level but "only me" (else mutual follows could never form under "friends and mutual follows" or "shared
// communities"); nobody starts following "only me", and a block either way refuses. Unfollowing and removing a follower
// need no access. Without that, the older stranger paths: post_id naming a
// public post Keşfet lists now, or, without it, an account in this process's copy of the feed suggestion pool (never
// older than 10 minutes). Both need the stranger's standing and a target whose level is public, so they open nothing the
// public view does not; they still tell an unverified caller to verify the email. The client's word is never read. Every
// refusal is 403, so a post ID tells nothing about a post the caller may not see.
// TEMPORARY: for a stranger without access, the post and pool paths read the target's users row and settings
// uncached; and every follow reads the target's users row once (FollowService needs the User). A viral account's users
// row is then a hot partition. Path: the level from the side record (profile:side) and
// the follow from the side record's bot and system bits instead of the row. Trigger: more than 5 K reads/s on one users
// partition, or follow reads above 10 % of users reads.
async function requireFollowAccess(
	ctx: Context<HonoEnv>,
	targetId: UserID,
	strangerPath: () => Promise<User>,
): Promise<User> {
	const viewer = profileViewer(ctx);
	const access = await ctx
		.get('userService')
		.accountService.lookupService.resolveProfileAccess({userId: viewer.user.id, targetId, viewer});
	if (access.audience === 'only_me' || access.blocked) throw new MissingAccessError();
	const open =
		access.view === 'full' || (access.view === 'public' && ctx.get('feedPostService').isFeedEnabled(viewer.user));
	// The follow back reads the target's 60 s following set, never its user_following partition per request.
	if (!open && !(await getFollowRepository().isFollowingCached(targetId, viewer.user.id))) return strangerPath();
	const target = await ctx.get('userRepository').findUnique(targetId);
	if (!target) throw new UnknownUserError();
	return target;
}

// the follow lists open on the full and the public view; a limited view (a block, a weak bond, a
// narrower level) and a refusal answer 403. A blocked account cannot read the lists. Only here and
// on the profile and post list routes does a stranger spend the daily budget.
async function requireListAccess(ctx: Context<HonoEnv>, targetId: UserID): Promise<void> {
	const viewer = profileViewer(ctx, {countStranger: true});
	const {view} = await ctx
		.get('userService')
		.accountService.lookupService.resolveProfileAccess({userId: viewer.user.id, targetId, viewer});
	if (view !== 'full' && view !== 'public') throw new MissingAccessError();
}

// The caller's standing on both stranger paths, after the path's own switch: the feed on, then a public commenter's
// standing on a clean account. An unverified email is the one refusal that says why.
function requireStrangerStanding(ctx: Context<HonoEnv>, user: User, now: number): void {
	if (!ctx.get('feedPostService').isFeedEnabled(user)) throw new MissingAccessError();
	if (hasStrangerFollowStanding(user, now)) return;
	if ((user.flags & DISCOVER_HIDDEN_AUTHOR_FLAGS) === 0n && !isMicupAccountLimited(user)) {
		requireEmailVerified(user);
	}
	throw new MissingAccessError();
}

async function requirePostFollowAccess(ctx: Context<HonoEnv>, targetId: UserID, postId: bigint): Promise<User> {
	const user = ctx.get('user');
	const {discover} = ctx.get('feedTimelineService');
	const now = Date.now();
	if (!discover.isEnabledFor(user)) throw new MissingAccessError();
	requireStrangerStanding(ctx, user, now);
	const author = await discover.discoverAuthorOf(postId, now);
	if (
		author?.id !== targetId ||
		!opensPublicPostsToStrangers(await ctx.get('userRepository').findSettings(targetId), author)
	) {
		throw new MissingAccessError();
	}
	return author;
}

async function requirePoolFollowAccess(ctx: Context<HonoEnv>, targetId: UserID): Promise<User> {
	const user = ctx.get('user');
	const suggestions = ctx.get('feedSuggestionService');
	const now = Date.now();
	// The switch and the pool first, both in memory: outside them the answer is the plain 403 from the profile access rule, never a prompt
	// about the caller's own email. The age rule before the standing, so a minor cannot tell from an email prompt
	// which accounts the pool lists.
	if (!suggestions.isEnabledFor(user) || !suggestions.isPooled(targetId, now)) throw new MissingAccessError();
	if (!isUserAdult(user.dateOfBirth)) throw new MissingAccessError();
	requireStrangerStanding(ctx, user, now);
	const userRepository = ctx.get('userRepository');
	const [target, settings] = await Promise.all([
		userRepository.findUnique(targetId),
		userRepository.findSettings(targetId),
	]);
	if (
		!target ||
		!isSuggestableAccount(target, now) ||
		!ctx.get('feedPostService').isFeedEnabled(target) ||
		!opensPublicPostsToStrangers(settings, target)
	) {
		throw new MissingAccessError();
	}
	return target;
}

export function FollowController(app: HonoApp) {
	app.put(
		'/users/:user_id/follow',
		RateLimitMiddleware(RateLimitConfigs.FOLLOW_CREATE),
		RateLimitMiddleware(RateLimitConfigs.FOLLOW_CREATE_DAILY),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', UserIdParam),
		Validator('json', FollowCreateRequest),
		OpenAPI({
			operationId: 'follow_user',
			summary: 'Follow user',
			description:
				'Follows a user. Refused for yourself, between accounts that block each other and past max_following. Without access to the profile, post_id may name a public post of the user that Discover lists now; without post_id, the user may be one of the popular accounts the feed suggests now (adult callers only). Emits FOLLOW_CREATE to the caller sessions.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const targetId = createUserID(ctx.req.valid('param').user_id);
			const postId = ctx.req.valid('json').post_id;
			const target = await requireFollowAccess(ctx, targetId, () =>
				postId === undefined ? requirePoolFollowAccess(ctx, targetId) : requirePostFollowAccess(ctx, targetId, postId),
			);
			await ctx.get('followService').follow({user: ctx.get('user'), target, requestCache: ctx.get('requestCache')});
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/users/:user_id/follow',
		RateLimitMiddleware(RateLimitConfigs.FOLLOW_DELETE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', UserIdParam),
		OpenAPI({
			operationId: 'unfollow_user',
			summary: 'Unfollow user',
			description: 'Stops following a user. Emits FOLLOW_DELETE to the caller sessions.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			await ctx.get('followService').removeFollow(ctx.get('user').id, createUserID(ctx.req.valid('param').user_id));
			return ctx.body(null, 204);
		},
	);
	app.get(
		'/users/:user_id/followers',
		RateLimitMiddleware(RateLimitConfigs.FOLLOW_LIST),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', UserIdParam),
		Validator('query', FollowersQuery),
		OpenAPI({
			operationId: 'list_user_followers',
			summary: 'List followers',
			description: 'Returns one page of the accounts that follow a user, newest follow first.',
			responseSchema: FollowListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => {
			const targetId = createUserID(ctx.req.valid('param').user_id);
			await requireListAccess(ctx, targetId);
			const {before, limit} = ctx.req.valid('query');
			return ctx.json(
				await ctx
					.get('followService')
					.listFollowers(targetId, {before, limit}, ctx.get('requestCache'), ctx.get('user').id),
			);
		},
	);
	app.get(
		'/users/:user_id/following',
		RateLimitMiddleware(RateLimitConfigs.FOLLOW_LIST),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', UserIdParam),
		Validator('query', FollowingQuery),
		OpenAPI({
			operationId: 'list_user_following',
			summary: 'List followed users',
			description: 'Returns one page of the accounts a user follows, by ascending user ID.',
			responseSchema: FollowListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => {
			const targetId = createUserID(ctx.req.valid('param').user_id);
			await requireListAccess(ctx, targetId);
			const {after, limit} = ctx.req.valid('query');
			return ctx.json(
				await ctx
					.get('followService')
					.listFollowing(
						targetId,
						{after: after === undefined ? undefined : createUserID(after), limit},
						ctx.get('requestCache'),
						ctx.get('user').id,
					),
			);
		},
	);
	app.delete(
		'/users/@me/followers/:user_id',
		RateLimitMiddleware(RateLimitConfigs.FOLLOWER_REMOVE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', UserIdParam),
		OpenAPI({
			operationId: 'remove_my_follower',
			summary: 'Remove follower',
			description: 'Makes an account stop following the current user.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			await ctx.get('followService').removeFollow(createUserID(ctx.req.valid('param').user_id), ctx.get('user').id);
			return ctx.body(null, 204);
		},
	);
}
