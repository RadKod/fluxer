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
import {
	StartVoiceActivityRequest,
	VoiceActivityQuery,
	VoiceActivitySession,
	VoiceActivitySessionNullable,
} from '@fluxer/schema/src/domains/voice_activity/VoiceActivitySchemas';

export function VoiceActivityController(app: HonoApp) {
	app.get(
		'/channels/:channel_id/activity',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.VOICE_ACTIVITY_READ),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ChannelIdParam),
		Validator('query', VoiceActivityQuery),
		OpenAPI({
			operationId: 'get_voice_activity',
			summary: 'Get the activity of a voice channel',
			description:
				'Returns the activity session running in the voice channel, or null. The caller must be in this voice channel (connection_id) with view and connect permission. Clients normally read the same session from the LiveKit room metadata. Returns 403 while table games are switched off.',
			responseSchema: VoiceActivitySessionNullable,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const session = await ctx.get('voiceActivityService').get({
				userId: ctx.get('user').id,
				channelId: createChannelID(ctx.req.valid('param').channel_id),
				connectionId: ctx.req.valid('query').connection_id,
			});
			return ctx.json(session);
		},
	);
	app.post(
		'/channels/:channel_id/activity',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.VOICE_ACTIVITY_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ChannelIdParam),
		Validator('json', StartVoiceActivityRequest),
		OpenAPI({
			operationId: 'start_voice_activity',
			summary: 'Start an activity in a voice channel',
			description:
				'Starts an activity session and writes it into the LiveKit room metadata. One activity runs per voice channel; while another session is running this answers 409 VOICE_ACTIVITY_CONFLICT. A session nobody ends expires after 12 hours. The caller must be in this voice channel (connection_id). Returns 403 while table games are switched off.',
			responseSchema: VoiceActivitySession,
			statusCode: 201,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {activity_id, connection_id} = ctx.req.valid('json');
			const session = await ctx.get('voiceActivityService').start({
				userId: ctx.get('user').id,
				channelId: createChannelID(ctx.req.valid('param').channel_id),
				connectionId: connection_id,
				activityId: activity_id,
			});
			return ctx.json(session, 201);
		},
	);
	app.delete(
		'/channels/:channel_id/activity',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.VOICE_ACTIVITY_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ChannelIdParam),
		Validator('query', VoiceActivityQuery),
		OpenAPI({
			operationId: 'end_voice_activity',
			summary: 'End the activity of a voice channel',
			description:
				'Ends the running activity session, whoever started it, and removes it from the LiveKit room metadata; with no session running it still clears the metadata. The caller must be in this voice channel (connection_id). Returns 403 while table games are switched off.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			await ctx.get('voiceActivityService').end({
				userId: ctx.get('user').id,
				channelId: createChannelID(ctx.req.valid('param').channel_id),
				connectionId: ctx.req.valid('query').connection_id,
			});
			return ctx.body(null, 204);
		},
	);
}
