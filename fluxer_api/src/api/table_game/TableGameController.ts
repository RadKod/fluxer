// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID} from '@app/api/BrandedTypes';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {VoiceRoomRateLimitConfigs} from '@app/api/rate_limit_configs/VoiceRoomRateLimitConfig';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {entityTagMatches} from '@app/api/utils/EntityTag';
import {Validator} from '@app/api/Validator';
import {Headers as HttpHeaders} from '@fluxer/constants/src/Headers';
import {ChannelIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {
	CreateTableGameRequest,
	JoinTableGameRequest,
	SpectateTableGameRequest,
	TableGameActionRequest,
	TableGameListResponse,
	TableGameReadQuery,
	TableGameSlotParam,
	TableGameSpectateResponse,
	TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import type {Context} from 'hono';

// a reply can carry the caller's own rack, so no shared cache may keep it. A null body: the service already
// matched If-None-Match and built nothing.
function privateRevalidated(ctx: Context<HonoEnv>, etag: string, body: object | null) {
	ctx.header(HttpHeaders.ETAG, etag);
	ctx.header(HttpHeaders.CACHE_CONTROL, 'private, no-cache');
	ctx.header('Vary', 'Authorization');
	const ifNoneMatch = ctx.req.header(HttpHeaders.IF_NONE_MATCH);
	if (body === null || (ifNoneMatch !== undefined && entityTagMatches(ifNoneMatch, etag))) return ctx.body(null, 304);
	return ctx.json(body);
}

export function TableGameController(app: HonoApp) {
	app.get(
		'/channels/:channel_id/table-games',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.TABLE_GAME_READ),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ChannelIdParam),
		Validator('query', TableGameReadQuery),
		OpenAPI({
			operationId: 'list_table_games',
			summary: 'List the game tables of a voice channel',
			description:
				'Returns the public summary of every table in the voice channel room. The caller must be in this voice channel (connection_id) with view and connect permission. Responses carry an ETag, Cache-Control: private, no-cache and Vary: Authorization. Returns 403 while table games are switched off.',
			responseSchema: TableGameListResponse,
			statusCode: [200, 304],
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const {body, etag} = await ctx.get('tableGameService').list({
				userId: ctx.get('user').id,
				channelId: createChannelID(ctx.req.valid('param').channel_id),
				connectionId: ctx.req.valid('query').connection_id,
			});
			return privateRevalidated(ctx, etag, body);
		},
	);
	app.get(
		'/channels/:channel_id/table-games/:slot',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.TABLE_GAME_READ),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', TableGameSlotParam),
		Validator('query', TableGameReadQuery),
		OpenAPI({
			operationId: 'get_table_game',
			summary: 'Get a game table',
			description:
				'Returns the table as the caller may see it: the public view, plus their own rack when they play at it. A caller who is not a player needs a watch ticket from watching the table (60 s) or a connection_id of theirs in this voice channel. Revalidate with If-None-Match against the ETag to get 304. Responses carry Cache-Control: private, no-cache and Vary: Authorization. Returns 403 while table games are switched off.',
			responseSchema: TableGameView,
			statusCode: [200, 304],
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			const {channel_id, slot} = ctx.req.valid('param');
			const {body, etag} = await ctx.get('tableGameService').get({
				userId: ctx.get('user').id,
				channelId: createChannelID(channel_id),
				slot,
				connectionId: ctx.req.valid('query').connection_id,
				ifNoneMatch: ctx.req.header(HttpHeaders.IF_NONE_MATCH),
			});
			return privateRevalidated(ctx, etag, body);
		},
	);
	app.post(
		'/channels/:channel_id/table-games/:slot',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.TABLE_GAME_CREATE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', TableGameSlotParam),
		Validator('json', CreateTableGameRequest),
		OpenAPI({
			operationId: 'create_table_game',
			summary: 'Open a game table',
			description:
				'Opens a lobby at a table slot of the channel room theme and seats the caller at position 1; a table that has ended is replaced. The caller must be in this voice channel (connection_id) and at no other table. A lobby that does not fill is closed after 10 minutes. Returns 403 while table games are switched off.',
			responseSchema: TableGameView,
			statusCode: 201,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {channel_id, slot} = ctx.req.valid('param');
			const {game, speed, connection_id} = ctx.req.valid('json');
			const result = await ctx.get('tableGameService').create({
				userId: ctx.get('user').id,
				channelId: createChannelID(channel_id),
				slot,
				game,
				speed,
				connectionId: connection_id,
			});
			return ctx.json(result, 201);
		},
	);
	app.put(
		'/channels/:channel_id/table-games/:slot/players/@me',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.TABLE_GAME_SEAT),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', TableGameSlotParam),
		Validator('json', JoinTableGameRequest),
		OpenAPI({
			operationId: 'join_table_game',
			summary: 'Sit down at a game table',
			description:
				'Takes a free position at the table; the game starts once every position is taken. The caller must be in this voice channel (connection_id) and at no other table. Returns 403 while table games are switched off.',
			responseSchema: TableGameView,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {channel_id, slot} = ctx.req.valid('param');
			const {position, connection_id} = ctx.req.valid('json');
			const result = await ctx.get('tableGameService').join({
				userId: ctx.get('user').id,
				channelId: createChannelID(channel_id),
				slot,
				position,
				connectionId: connection_id,
			});
			return ctx.json(result);
		},
	);
	app.delete(
		'/channels/:channel_id/table-games/:slot/players/@me',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.TABLE_GAME_SEAT),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', TableGameSlotParam),
		OpenAPI({
			operationId: 'leave_table_game',
			summary: 'Leave a game table',
			description:
				'Leaves the lobby, or forfeits a game in progress, which ends it. Returns 403 while table games are switched off.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {channel_id, slot} = ctx.req.valid('param');
			await ctx
				.get('tableGameService')
				.leave({userId: ctx.get('user').id, channelId: createChannelID(channel_id), slot});
			return ctx.body(null, 204);
		},
	);
	app.post(
		'/channels/:channel_id/table-games/:slot/actions',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.TABLE_GAME_ACTION),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', TableGameSlotParam),
		Validator('json', TableGameActionRequest),
		OpenAPI({
			operationId: 'act_table_game',
			summary: 'Make a move at a game table',
			description:
				"Applies a player's move against the table version it was made on; a stale version answers 409. A tick, only from a player, settles an expired turn. Returns 403 while table games are switched off.",
			responseSchema: TableGameView,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {channel_id, slot} = ctx.req.valid('param');
			const {version, action} = ctx.req.valid('json');
			const result = await ctx
				.get('tableGameService')
				.act({userId: ctx.get('user').id, channelId: createChannelID(channel_id), slot, version, action});
			return ctx.json(result);
		},
	);
	app.put(
		'/channels/:channel_id/table-games/:slot/spectators/@me',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.TABLE_GAME_SPECTATE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', TableGameSlotParam),
		Validator('json', SpectateTableGameRequest),
		OpenAPI({
			operationId: 'spectate_table_game',
			summary: 'Watch a game table',
			description:
				'Subscribes the caller to the table updates while there is room among the spectators; otherwise subscribed is false and the caller polls the table with its 60 s watch ticket. The caller must be in this voice channel (connection_id) and not a player at the table. Returns 403 while table games are switched off.',
			responseSchema: TableGameSpectateResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {channel_id, slot} = ctx.req.valid('param');
			const result = await ctx.get('tableGameService').spectate({
				userId: ctx.get('user').id,
				channelId: createChannelID(channel_id),
				slot,
				connectionId: ctx.req.valid('json').connection_id,
			});
			return ctx.json(result);
		},
	);
	app.delete(
		'/channels/:channel_id/table-games/:slot/spectators/@me',
		RateLimitMiddleware(VoiceRoomRateLimitConfigs.TABLE_GAME_SPECTATE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', TableGameSlotParam),
		OpenAPI({
			operationId: 'unspectate_table_game',
			summary: 'Stop watching a game table',
			description: "Drops the caller's table update subscription. Returns 403 while table games are switched off.",
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Channels',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {channel_id, slot} = ctx.req.valid('param');
			await ctx
				.get('tableGameService')
				.unspectate({userId: ctx.get('user').id, channelId: createChannelID(channel_id), slot});
			return ctx.body(null, 204);
		},
	);
}
