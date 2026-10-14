// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const GuildRosterRateLimitConfigs = {
	GUILD_ROSTER_EVENTS_LIST: {
		bucket: 'guild:roster:list::guild_id',
		config: {limit: 30, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	GUILD_ROSTER_EVENTS_WRITE: {
		bucket: 'guild:roster:write::guild_id',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
} as const;
