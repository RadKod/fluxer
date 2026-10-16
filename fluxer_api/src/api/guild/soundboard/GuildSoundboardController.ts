// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createGuildSoundID} from '@app/api/BrandedTypes';
import {LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {RequestBodyLimit} from '@app/api/middleware/RequestBodyLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {GuildSoundboardRateLimitConfigs as Limits} from '@app/api/rate_limit_configs/GuildSoundboardRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {
	GuildSoundboardGuildParam,
	GuildSoundboardListResponse,
	GuildSoundboardPlayParam,
	GuildSoundboardPlayRequest,
	GuildSoundboardSoundParam,
	GuildSoundboardSoundResponse,
	GuildSoundboardUpdateRequest,
	GuildSoundboardUploadRequest,
} from '@fluxer/schema/src/domains/guild/GuildSoundboardSchemas';

// Base64 of SOUNDBOARD_MAX_SIZE_BYTES (1,333,336 characters) plus the JSON envelope.
const GUILD_SOUNDBOARD_UPLOAD_MAX_BODY_BYTES = 1_400_000;

export function GuildSoundboardController(app: HonoApp) {
	app.get(
		'/guilds/:guild_id/soundboard-sounds',
		RateLimitMiddleware(Limits.GUILD_SOUNDBOARD_LIST),
		LoginRequired,
		Validator('param', GuildSoundboardGuildParam),
		OpenAPI({
			operationId: 'list_guild_soundboard_sounds',
			summary: 'List guild soundboard sounds',
			description: 'Returns sound metadata for guild members.',
			responseSchema: GuildSoundboardListResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const sounds = await ctx
				.get('guildSoundboardService')
				.list({userId: ctx.get('user').id, guildId: createGuildID(ctx.req.valid('param').guild_id)});
			return ctx.json({sounds});
		},
	);
	app.post(
		'/guilds/:guild_id/soundboard-sounds',
		RateLimitMiddleware(Limits.GUILD_SOUNDBOARD_UPLOAD),
		LoginRequired,
		RequestBodyLimit(GUILD_SOUNDBOARD_UPLOAD_MAX_BODY_BYTES),
		Validator('param', GuildSoundboardGuildParam),
		Validator('json', GuildSoundboardUploadRequest),
		OpenAPI({
			operationId: 'create_guild_soundboard_sound',
			summary: 'Upload a guild soundboard sound',
			description: 'Creates a validated short audio clip with expression permissions.',
			requestSchema: GuildSoundboardUploadRequest,
			responseSchema: GuildSoundboardSoundResponse,
			statusCode: 201,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const sound = await ctx.get('guildSoundboardService').upload({
				userId: ctx.get('user').id,
				guildId: createGuildID(ctx.req.valid('param').guild_id),
				...ctx.req.valid('json'),
			});
			return ctx.json(sound, 201);
		},
	);
	app.patch(
		'/guilds/:guild_id/soundboard-sounds/:sound_id',
		RateLimitMiddleware(Limits.GUILD_SOUNDBOARD_MUTATE),
		LoginRequired,
		Validator('param', GuildSoundboardSoundParam),
		Validator('json', GuildSoundboardUpdateRequest),
		OpenAPI({
			operationId: 'update_guild_soundboard_sound',
			summary: 'Update a guild soundboard sound',
			description: 'Changes the name or playback volume with expression permissions.',
			requestSchema: GuildSoundboardUpdateRequest,
			responseSchema: GuildSoundboardSoundResponse,
			statusCode: 200,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const params = ctx.req.valid('param');
			return ctx.json(
				await ctx.get('guildSoundboardService').update({
					userId: ctx.get('user').id,
					guildId: createGuildID(params.guild_id),
					soundId: createGuildSoundID(params.sound_id),
					...ctx.req.valid('json'),
				}),
			);
		},
	);
	app.delete(
		'/guilds/:guild_id/soundboard-sounds/:sound_id',
		RateLimitMiddleware(Limits.GUILD_SOUNDBOARD_MUTATE),
		LoginRequired,
		Validator('param', GuildSoundboardSoundParam),
		OpenAPI({
			operationId: 'delete_guild_soundboard_sound',
			summary: 'Delete a guild soundboard sound',
			description: 'Removes a sound with expression permissions.',
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const params = ctx.req.valid('param');
			await ctx.get('guildSoundboardService').delete({
				userId: ctx.get('user').id,
				guildId: createGuildID(params.guild_id),
				soundId: createGuildSoundID(params.sound_id),
			});
			return ctx.body(null, 204);
		},
	);
	app.post(
		'/channels/:channel_id/soundboard-sounds/:sound_id/play',
		RateLimitMiddleware(Limits.GUILD_SOUNDBOARD_PLAY_REQUEST),
		LoginRequired,
		Validator('param', GuildSoundboardPlayParam),
		Validator('json', GuildSoundboardPlayRequest),
		OpenAPI({
			operationId: 'play_guild_soundboard_sound',
			summary: 'Play a guild soundboard sound',
			description: 'Plays a sound to eligible voice sessions in the current channel.',
			requestSchema: GuildSoundboardPlayRequest,
			responseSchema: null,
			statusCode: 204,
			security: ['botToken', 'bearerToken', 'sessionToken'],
			tags: ['Channels'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const params = ctx.req.valid('param');
			const body = ctx.req.valid('json');
			await ctx.get('guildSoundboardPlayService').play({
				userId: ctx.get('user').id,
				channelId: createChannelID(params.channel_id),
				soundId: createGuildSoundID(params.sound_id),
				sessionId: body.session_id,
				connectionId: body.connection_id,
			});
			return ctx.body(null, 204);
		},
	);
}
