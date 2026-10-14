// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

// Buckets embed the route params, so every limit is per user and channel (and per table where :slot appears).
export const VoiceRoomRateLimitConfigs = {
	VOICE_SEAT_TAKE: {
		bucket: 'voice_seat:take::channel_id',
		config: {limit: 10, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	TABLE_GAME_READ: {
		bucket: 'table_game:read::channel_id',
		config: {limit: 60, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	TABLE_GAME_CREATE: {
		bucket: 'table_game:create::channel_id',
		config: {limit: 5, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	TABLE_GAME_SEAT: {
		bucket: 'table_game:seat::channel_id::slot',
		config: {limit: 10, windowMs: ms('30 seconds')},
	} as RouteRateLimitConfig,
	TABLE_GAME_ACTION: {
		bucket: 'table_game:action::channel_id::slot',
		config: {limit: 30, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	TABLE_GAME_SPECTATE: {
		bucket: 'table_game:spectate::channel_id',
		config: {limit: 10, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
} as const;
