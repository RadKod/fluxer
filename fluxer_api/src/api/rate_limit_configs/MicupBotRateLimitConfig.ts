// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
export const MicupBotRateLimitConfigs = {
	GUILD_MICUPBOT_READ: {
		bucket: 'guild:micupbot:read::guild_id',
		config: {limit: 30, windowMs: 10_000},
	} satisfies RouteRateLimitConfig,
	GUILD_MICUPBOT_WRITE: {
		bucket: 'guild:micupbot:write::guild_id',
		config: {limit: 10, windowMs: 10_000},
	} satisfies RouteRateLimitConfig,
	GUILD_MICUPBOT_LEADERBOARD: {
		bucket: 'guild:micupbot:leaderboard::guild_id',
		config: {limit: 20, windowMs: 10_000},
	} satisfies RouteRateLimitConfig,
} as const;
