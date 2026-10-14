// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const MessageComponentRateLimitConfigs = {
	// Per user and channel (the middleware keys every bucket by the caller).
	CHANNEL_MESSAGE_COMPONENTS: {
		bucket: 'channel:message:components::channel_id',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
} as const;
