// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RouteRateLimitConfig} from '@app/api/middleware/RateLimitMiddleware';
import {ms} from 'itty-time';

export const GuildSoundboardRateLimitConfigs = {
	GUILD_SOUNDBOARD_PLAY_REQUEST: {
		bucket: 'user:soundboard:play',
		config: {limit: 10, windowMs: ms('5 seconds')},
	} as RouteRateLimitConfig,
	GUILD_SOUNDBOARD_LIST: {
		bucket: 'guild:soundboard:list::guild_id',
		config: {limit: 40, windowMs: ms('10 seconds')},
	} as RouteRateLimitConfig,
	GUILD_SOUNDBOARD_UPLOAD: {
		bucket: 'guild:soundboard:upload::guild_id',
		config: {limit: 10, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
	GUILD_SOUNDBOARD_MUTATE: {
		bucket: 'guild:soundboard:mutate::guild_id',
		config: {limit: 20, windowMs: ms('1 minute')},
	} as RouteRateLimitConfig,
} as const;

// sanalyer: four plays per five seconds per user; the gateway bucket in guild_voice_soundboard.erl matches.
export const SOUNDBOARD_USER_PLAY_BUCKET = {limit: 4, windowMs: 5000};
// Four tokens draining over 2.5 seconds give eight plays per five seconds with a burst of four.
export const SOUNDBOARD_CHANNEL_PLAY_BUCKET = {limit: 4, windowMs: 2500};
