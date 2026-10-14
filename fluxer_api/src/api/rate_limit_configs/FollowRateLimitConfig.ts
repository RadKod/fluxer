// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const FollowRateLimitConfigs = {
	FOLLOW_CREATE: {
		bucket: 'user:follow:create',
		config: {limit: 20, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	// A daily cap on top of the burst limit, so one account cannot churn follows all day (max_following caps the total).
	FOLLOW_CREATE_DAILY: {
		bucket: 'user:follow:create:daily',
		config: {limit: 400, windowMs: ms('1 day'), exemptFromGlobal: true},
	} as RouteRateLimitConfig,
	FOLLOW_DELETE: {
		bucket: 'user:follow:delete',
		config: {limit: 20, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FOLLOW_LIST: {
		bucket: 'user:follow:list',
		config: {limit: 40, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	FOLLOWER_REMOVE: {
		bucket: 'user:follower:remove',
		config: {limit: 20, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
} as const;
