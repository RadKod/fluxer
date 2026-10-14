// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const PremiumTrialRateLimitConfigs = {
	PREMIUM_TRIAL_GET: {
		bucket: 'premium:trial:get',
		config: {limit: 20, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	PREMIUM_TRIAL_CLAIM: {
		bucket: 'premium:trial:claim',
		config: {limit: 3, windowMs: ms('1 hour')},
	} as RouteRateLimitConfig,
	// TEMPORARY: 20 granted trials a day per IPv4 /24 or IPv6 /48 is tight behind mobile carrier CGNAT; move it to the
	// limit config with carrier range exemptions once trial 429s pass 5% of claims or claims pass 100K a day.
	PREMIUM_TRIAL_CLAIM_NETWORK: {
		bucket: 'premium:trial:claim:network',
		config: {limit: 20, windowMs: ms('1 day')},
		scope: 'shared',
	} as RouteRateLimitConfig,
} as const;
