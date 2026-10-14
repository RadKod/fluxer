// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

// Bursts only: the daily cap on posts is the max_feed_posts_per_day limit.
export const FeedRateLimitConfigs = {
	FEED_ATTACHMENT_UPLOAD: {
		bucket: 'feed:attachment:upload',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_POST_CREATE: {
		bucket: 'feed:post:create',
		config: {limit: 5, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_POST_GET: {
		bucket: 'feed:post:get',
		config: {limit: 60, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_POST_DELETE: {
		bucket: 'feed:post:delete',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_HOME: {
		bucket: 'feed:home',
		config: {limit: 20, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_DISCOVER: {
		bucket: 'feed:discover',
		config: {limit: 20, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	// One request per feed page visit; the rest are reloads.
	FEED_SUGGESTIONS: {
		bucket: 'feed:suggestions',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_USER_POSTS: {
		bucket: 'feed:user_posts',
		config: {limit: 30, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_POST_LIKE: {
		bucket: 'feed:post:like',
		config: {limit: 30, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_POST_UNLIKE: {
		bucket: 'feed:post:unlike',
		config: {limit: 30, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_POLL_VOTE: {
		bucket: 'feed:poll:vote',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_POST_LIKERS: {
		bucket: 'feed:post:likers',
		config: {limit: 20, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_COMMENTS_LIST: {
		bucket: 'feed:comments:list',
		config: {limit: 40, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_COMMENT_CREATE: {
		bucket: 'feed:comment:create',
		config: {limit: 5, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	// A daily cap on top of the burst limit; it also bounds a ten day feed_comments_by_author bucket at 5000 rows.
	FEED_COMMENT_CREATE_DAILY: {
		bucket: 'feed:comment:create:daily',
		config: {limit: 500, windowMs: ms('1 day'), exemptFromGlobal: true},
	} as RouteRateLimitConfig,
	FEED_COMMENT_DELETE: {
		bucket: 'feed:comment:delete',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_NOTIFICATIONS: {
		bucket: 'feed:notifications',
		config: {limit: 20, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	// One mark-read per close of the activity view (10 per 10 s).
	FEED_NOTIFICATION_ACK: {
		bucket: 'feed:notifications:ack',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	// One batch a minute passes the per-account gate (FeedViewService); the rest are retries after a 429. Outside the global
	// limit, so view batches never cost a session.
	FEED_VIEWS: {
		bucket: 'feed:views',
		config: {limit: 6, windowMs: ms('1 minute'), exemptFromGlobal: true},
	} as RouteRateLimitConfig,
	// Starting an upload creates a Bunny video; at most 3 unfinished videos per author on top of this.
	FEED_VIDEO_CREATE: {
		bucket: 'feed:video:create',
		config: {limit: 3, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	FEED_VIDEO_SIGN: {
		bucket: 'feed:video:sign',
		config: {limit: 10, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	FEED_VIDEO_LIST: {
		bucket: 'feed:video:list',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FEED_VIDEO_CANCEL: {
		bucket: 'feed:video:cancel',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	// Unauthenticated, so counted per IP; Bunny sends every status change of every video from a few addresses.
	FEED_VIDEO_WEBHOOK: {
		bucket: 'feed:video:webhook',
		config: {limit: 60000, windowMs: ms('1 minute'), exemptFromGlobal: true},
	} as RouteRateLimitConfig,
	ADMIN_FEED_MODERATION: {
		bucket: 'admin:feed:moderation',
		config: {limit: 100, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
} as const;
