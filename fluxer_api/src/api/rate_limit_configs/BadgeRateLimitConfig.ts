// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const BadgeRateLimitConfigs = {
	ADMIN_BADGE_LIST: {
		bucket: 'admin:badge:list',
		config: {limit: 60, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	ADMIN_BADGE_UPDATE: {
		bucket: 'admin:badge:update',
		config: {limit: 30, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	ADMIN_USER_BADGE_UPDATE: {
		bucket: 'admin:user:badge:update',
		config: {limit: 100, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
} as const;
