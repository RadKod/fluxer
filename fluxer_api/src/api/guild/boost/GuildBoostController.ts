// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {GuildBoostRateLimitConfigs} from '@app/api/rate_limit_configs/GuildBoostRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {
	GuildBoostCreateRequest,
	GuildBoostListQuery,
	GuildIdBoostIdParam,
} from '@fluxer/schema/src/domains/boost/BoostRequestSchemas';
import {
	GuildBoostListResponse,
	GuildBoostResponse,
	UserBoostSlotListResponse,
} from '@fluxer/schema/src/domains/boost/BoostResponseSchemas';
import {GuildIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';

export function GuildBoostController(app: HonoApp) {
	app.get(
		'/guilds/:guild_id/boosts',
		RateLimitMiddleware(GuildBoostRateLimitConfigs.GUILD_BOOSTS_LIST),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		Validator('query', GuildBoostListQuery),
		OpenAPI({
			operationId: 'list_guild_boosts',
			summary: 'List guild boosts',
			description: 'Returns one page of the boosts of a guild, newest first. The caller must be a member.',
			responseSchema: GuildBoostListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const {before, limit} = ctx.req.valid('query');
			// Membership check: the Gateway guild read refuses a non-member or an unavailable guild.
			await ctx.get('guildService').data.operations.getGuild({userId: ctx.get('user').id, guildId});
			return ctx.json(
				await ctx.get('guildBoostService').listBoosts({guildId, limit, before, requestCache: ctx.get('requestCache')}),
			);
		},
	);
	app.put(
		'/guilds/:guild_id/boosts',
		RateLimitMiddleware(GuildBoostRateLimitConfigs.GUILD_BOOST_CREATE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		Validator('json', GuildBoostCreateRequest),
		OpenAPI({
			operationId: 'create_guild_boost',
			summary: 'Boost guild',
			description:
				'Spends one of the free boost slots of a member on the guild. A slot boosts one guild at a time. The guild tier and boost count are recounted in the background and arrive as GUILD_UPDATE.',
			responseSchema: GuildBoostResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const user = ctx.get('user');
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const guild = await ctx.get('guildService').data.operations.getGuild({userId: user.id, guildId});
			return ctx.json(
				await ctx.get('guildBoostService').boost({
					user,
					guild,
					slotId: ctx.req.valid('json').slot_id,
					requestCache: ctx.get('requestCache'),
				}),
			);
		},
	);
	app.delete(
		'/guilds/:guild_id/boosts/:boost_id',
		RateLimitMiddleware(GuildBoostRateLimitConfigs.GUILD_BOOST_DELETE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdBoostIdParam),
		OpenAPI({
			operationId: 'delete_guild_boost',
			summary: 'Remove guild boost',
			description: 'Takes the caller boost off the guild and frees its slot.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const {guild_id, boost_id} = ctx.req.valid('param');
			// Only the owner of the boost can take it off, so no guild permission is involved.
			await ctx.get('guildBoostService').removeBoost({
				userId: ctx.get('user').id,
				guildId: createGuildID(guild_id),
				boostId: boost_id,
			});
			return ctx.body(null, 204);
		},
	);
	app.get(
		'/users/@me/boost-slots',
		RateLimitMiddleware(GuildBoostRateLimitConfigs.USER_BOOST_SLOTS),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'list_my_boost_slots',
			summary: 'List my boost slots',
			description: 'Returns the boost slots of the current user and the guild each one boosts.',
			responseSchema: UserBoostSlotListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => ctx.json(await ctx.get('guildBoostService').listSlots(ctx.get('user'))),
	);
}
