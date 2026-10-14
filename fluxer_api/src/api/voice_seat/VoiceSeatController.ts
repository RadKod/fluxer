// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID} from '@app/api/BrandedTypes';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {VoiceRoomRateLimitConfigs} from '@app/api/rate_limit_configs/VoiceRoomRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {ChannelIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {PutVoiceSeatRequest, VoiceSeatResponse} from '@fluxer/schema/src/domains/voice_seat/VoiceSeatSchemas';

export function VoiceSeatController(app: HonoApp) {
	app.put(
		'/channels/:channel_id/voice-seat',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.VOICE_SEAT_TAKE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ChannelIdParam),
		Validator('json', PutVoiceSeatRequest),
		OpenAPI({
			operationId: 'put_voice_seat',
			summary: 'Take a seat in the voice channel room',
			description:
				"Seats the caller's own voice connection on a free lounge or watch seat of the channel room theme, or on a lounge seat the server picks when seat is null. The caller must be in this voice channel with that connection. Returns 403 while 3D rooms are switched off and 429 while the channel's seats change more than 20 times a second.",
			responseSchema: VoiceSeatResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {connection_id, seat} = ctx.req.valid('json');
			const result = await ctx.get('voiceSeatService').takeSeat({
				userId: ctx.get('user').id,
				channelId: createChannelID(ctx.req.valid('param').channel_id),
				connectionId: connection_id,
				seat,
			});
			return ctx.json(result);
		},
	);
}
