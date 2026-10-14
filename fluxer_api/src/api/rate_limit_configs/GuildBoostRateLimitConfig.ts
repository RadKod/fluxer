// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const GuildBoostRateLimitConfigs = {
	GUILD_BOOSTS_LIST: {
		bucket: 'guild:boosts:list::guild_id',
		config: {limit: 40, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	GUILD_BOOST_CREATE: {
		bucket: 'guild:boost:create::guild_id',
		config: {limit: 10, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	GUILD_BOOST_DELETE: {
		bucket: 'guild:boost:delete::guild_id',
		config: {limit: 10, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	USER_BOOST_SLOTS: {
		bucket: 'user:boost_slots',
		config: {limit: 20, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
} as const;
