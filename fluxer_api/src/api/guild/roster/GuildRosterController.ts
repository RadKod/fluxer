// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {GuildRosterRateLimitConfigs} from '@app/api/rate_limit_configs/GuildRosterRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {
	GuildIdRosterEventIdParam,
	GuildRosterEventCreateRequest,
	GuildRosterEventUpdateRequest,
} from '@fluxer/schema/src/domains/roster/GuildRosterRequestSchemas';
import {
	GuildRosterEventListResponse,
	GuildRosterEventResponse,
} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';

export function GuildRosterController(app: HonoApp) {
	app.get(
		'/guilds/:guild_id/roster-events',
		RateLimitMiddleware(GuildRosterRateLimitConfigs.GUILD_ROSTER_EVENTS_LIST),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		OpenAPI({
			operationId: 'list_guild_roster_events',
			summary: 'List guild roster events',
			description:
				'Returns the configured hourly events, feature status and official bot invite details. Requires MANAGE_GUILD. Roster members are not included.',
			responseSchema: GuildRosterEventListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const {checkPermission, guildData} = await ctx
				.get('guildService')
				.getGuildAuthenticated({userId: ctx.get('user').id, guildId});
			await checkPermission(Permissions.MANAGE_GUILD);
			return ctx.json(await ctx.get('guildRosterSettingsService').list({guild: guildData, userId: ctx.get('user').id}));
		},
	);
	app.post(
		'/guilds/:guild_id/roster-events',
		RateLimitMiddleware(GuildRosterRateLimitConfigs.GUILD_ROSTER_EVENTS_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		Validator('json', GuildRosterEventCreateRequest),
		OpenAPI({
			operationId: 'create_guild_roster_event',
			summary: 'Create guild roster event',
			description:
				'Creates an hourly roster event. Requires MANAGE_GUILD and the roster feature. The caller must be able to view, connect to and move members in the event voice channel, and view and send in the announcement channel. Channels and the optional role must belong to this guild; @everyone cannot be mentioned. Unmentionable roles require MENTION_EVERYONE. At most 10 events are allowed per guild.',
			responseSchema: GuildRosterEventResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const {checkPermission, guildData} = await ctx
				.get('guildService')
				.getGuildAuthenticated({userId: ctx.get('user').id, guildId});
			await checkPermission(Permissions.MANAGE_GUILD);
			return ctx.json(
				await ctx.get('guildRosterSettingsService').create({
					guild: guildData,
					userId: ctx.get('user').id,
					data: ctx.req.valid('json'),
				}),
			);
		},
	);
	app.patch(
		'/guilds/:guild_id/roster-events/:event_id',
		RateLimitMiddleware(GuildRosterRateLimitConfigs.GUILD_ROSTER_EVENTS_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdRosterEventIdParam),
		Validator('json', GuildRosterEventUpdateRequest),
		OpenAPI({
			operationId: 'update_guild_roster_event',
			summary: 'Update guild roster event',
			description:
				'Updates at least one event field. Requires MANAGE_GUILD and the roster feature; rechecks the caller channel and role permissions. All channels and roles must belong to this guild. A null mention_role_id removes the mention. An unknown event returns 404.',
			responseSchema: GuildRosterEventResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const {checkPermission, guildData} = await ctx
				.get('guildService')
				.getGuildAuthenticated({userId: ctx.get('user').id, guildId});
			await checkPermission(Permissions.MANAGE_GUILD);
			return ctx.json(
				await ctx.get('guildRosterSettingsService').update({
					guild: guildData,
					userId: ctx.get('user').id,
					eventId: ctx.req.valid('param').event_id,
					data: ctx.req.valid('json'),
				}),
			);
		},
	);
	app.delete(
		'/guilds/:guild_id/roster-events/:event_id',
		RateLimitMiddleware(GuildRosterRateLimitConfigs.GUILD_ROSTER_EVENTS_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdRosterEventIdParam),
		OpenAPI({
			operationId: 'delete_guild_roster_event',
			summary: 'Delete guild roster event',
			description:
				'Deletes an event and its scheduling index entry. Requires MANAGE_GUILD and the roster feature. An unknown event returns 404.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const {checkPermission, guildData} = await ctx
				.get('guildService')
				.getGuildAuthenticated({userId: ctx.get('user').id, guildId});
			await checkPermission(Permissions.MANAGE_GUILD);
			await ctx.get('guildRosterSettingsService').delete({
				guild: guildData,
				userId: ctx.get('user').id,
				eventId: ctx.req.valid('param').event_id,
			});
			return ctx.body(null, 204);
		},
	);
}
