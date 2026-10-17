// SPDX-License-Identifier: AGPL-3.0-or-later

import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import {CosmeticRateLimitConfigs} from '@app/api/rate_limit_configs/CosmeticRateLimitConfig';
import {GuildBoostRateLimitConfigs} from '@app/api/rate_limit_configs/GuildBoostRateLimitConfig';
import {VoiceRoomRateLimitConfigs} from '@app/api/rate_limit_configs/VoiceRoomRateLimitConfig';
import {describe, expect, it} from 'vitest';

describe('RateLimitConfigs', () => {
	it('carries the cosmetic and community boost buckets like every other section', () => {
		for (const section of [CosmeticRateLimitConfigs, GuildBoostRateLimitConfigs]) {
			for (const [name, config] of Object.entries(section)) {
				expect((RateLimitConfigs as Record<string, unknown>)[name]).toBe(config);
			}
		}
	});

	it('carries the voice seat, table game and voice activity buckets with their per-channel and per-table keys', () => {
		const expected = {
			VOICE_SEAT_TAKE: ['voice_seat:take::channel_id', 10, 10_000],
			TABLE_GAME_READ: ['table_game:read::channel_id', 60, 10_000],
			TABLE_GAME_CREATE: ['table_game:create::channel_id', 5, 60_000],
			TABLE_GAME_SEAT: ['table_game:seat::channel_id::slot', 10, 30_000],
			TABLE_GAME_ACTION: ['table_game:action::channel_id::slot', 30, 10_000],
			TABLE_GAME_SPECTATE: ['table_game:spectate::channel_id', 10, 60_000],
			VOICE_ACTIVITY_READ: ['voice_activity:read::channel_id', 30, 10_000],
			VOICE_ACTIVITY_WRITE: ['voice_activity:write::channel_id', 10, 60_000],
		};
		expect(Object.keys(VoiceRoomRateLimitConfigs).sort()).toEqual(Object.keys(expected).sort());
		for (const [name, [bucket, limit, windowMs]] of Object.entries(expected)) {
			const config = VoiceRoomRateLimitConfigs[name as keyof typeof VoiceRoomRateLimitConfigs];
			expect(config).toEqual({bucket, config: {limit, windowMs}});
			expect((RateLimitConfigs as Record<string, unknown>)[name]).toBe(config);
		}
	});
});
