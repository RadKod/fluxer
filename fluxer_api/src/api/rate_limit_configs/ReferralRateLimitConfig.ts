// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const ReferralRateLimitConfigs = {
	REFERRAL_ME: {
		bucket: 'referral:me',
		config: {limit: 30, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	ADMIN_REFERRAL: {
		bucket: 'admin:referral',
		config: {limit: 60, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
} as const;
