// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createMessageID, createUserID} from '@app/api/BrandedTypes';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {MicupBotRateLimitConfigs} from '@app/api/rate_limit_configs/MicupBotRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {Permissions} from '@fluxer/constants/src/ChannelConstants';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {UnknownGuildError} from '@fluxer/errors/src/domains/guild/UnknownGuildError';
import {GuildIdParam, GuildIdUserIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {
	GuildIdMessageIdParam,
	GuildIdUserIdWarningIdParam,
	MicupBotAutomodUpdateRequest,
	MicupBotLeaderboardQuery,
	MicupBotLevelRewardsUpdateRequest,
	MicupBotReactionRolePanelCreateRequest,
	MicupBotSettingsUpdateRequest,
} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import {
	MicupBotAutomodResponse,
	MicupBotLeaderboardResponse,
	MicupBotLevelRewardsResponse,
	MicupBotReactionRolePanelListResponse,
	MicupBotReactionRolePanelResponse,
	MicupBotSettingsResponse,
	MicupBotWarningListResponse,
} from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';
export function MicupBotController(app: HonoApp) {
	app.get(
		'/guilds/:guild_id/micupbot/settings',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_READ),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		OpenAPI({
			operationId: 'get_guild_micupbot_settings',
			summary: 'Get guild micupbot settings',
			description:
				'Read community bot settings, feature status, invite permissions, role warnings and default messages. Requires MANAGE_GUILD.',
			responseSchema: MicupBotSettingsResponse,
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
			return ctx.json(await ctx.get('micupBotSettingsService').getSettings({guildData, userId: ctx.get('user').id}));
		},
	);
	app.patch(
		'/guilds/:guild_id/micupbot/settings',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		Validator('json', MicupBotSettingsUpdateRequest),
		OpenAPI({
			operationId: 'update_guild_micupbot_settings',
			summary: 'Update guild micupbot settings',
			description:
				'Update at least one bot setting. Requires MANAGE_GUILD and the feature; autoroles also require MANAGE_ROLES and safe roles below the caller and bot. Selected channels must belong to this guild and allow viewing, sending and embeds. Module changes are limited to once per 60 seconds.',
			responseSchema: MicupBotSettingsResponse,
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
			if (ctx.req.valid('json').autorole_ids !== undefined) await checkPermission(Permissions.MANAGE_ROLES);
			return ctx.json(
				await ctx
					.get('micupBotSettingsService')
					.updateSettings({guildData, userId: ctx.get('user').id, data: ctx.req.valid('json')}),
			);
		},
	);
	app.get(
		'/guilds/:guild_id/micupbot/automod',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_READ),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		OpenAPI({
			operationId: 'get_guild_micupbot_automod',
			summary: 'Get guild micupbot automod',
			description: 'Read all six automod rules, including disabled defaults. Requires MANAGE_GUILD.',
			responseSchema: MicupBotAutomodResponse,
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
			return ctx.json(await ctx.get('micupBotSettingsService').getAutomod({guildData, userId: ctx.get('user').id}));
		},
	);
	app.put(
		'/guilds/:guild_id/micupbot/automod',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		Validator('json', MicupBotAutomodUpdateRequest),
		OpenAPI({
			operationId: 'update_guild_micupbot_automod',
			summary: 'Update guild micupbot automod',
			description:
				'Replace the automod rules. Requires MANAGE_GUILD, MANAGE_MESSAGES and the feature; delete_mute also requires MODERATE_MEMBERS. Rule thresholds, exempt IDs and word lists are bounded.',
			responseSchema: MicupBotAutomodResponse,
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
			await checkPermission(Permissions.MANAGE_MESSAGES);
			if (ctx.req.valid('json').rules.some((rule) => rule.enabled && rule.action === 'delete_mute'))
				await checkPermission(Permissions.MODERATE_MEMBERS);
			return ctx.json(
				await ctx
					.get('micupBotSettingsService')
					.updateAutomod({guildData, userId: ctx.get('user').id, data: ctx.req.valid('json')}),
			);
		},
	);
	app.get(
		'/guilds/:guild_id/micupbot/reaction-roles',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_READ),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		OpenAPI({
			operationId: 'list_guild_micupbot_reaction_roles',
			summary: 'List guild micupbot reaction roles',
			description: 'List the reaction role panels configured in this guild. Requires MANAGE_GUILD.',
			responseSchema: MicupBotReactionRolePanelListResponse,
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
			return ctx.json(await ctx.get('micupBotSettingsService').listPanels({guildData, userId: ctx.get('user').id}));
		},
	);
	app.post(
		'/guilds/:guild_id/micupbot/reaction-roles',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		Validator('json', MicupBotReactionRolePanelCreateRequest),
		OpenAPI({
			operationId: 'create_guild_micupbot_reaction_role',
			summary: 'Create guild micupbot reaction role',
			description:
				'Create a bot-owned reaction role panel with 1-20 unique emoji and role pairs. Requires MANAGE_GUILD, MANAGE_ROLES, the feature, bot membership and channel VIEW_CHANNEL, SEND_MESSAGES and ADD_REACTIONS. Roles must be safe and below the caller and bot. At most 25 panels are allowed.',
			responseSchema: MicupBotReactionRolePanelResponse,
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
			await checkPermission(Permissions.MANAGE_ROLES);
			return ctx.json(
				await ctx.get('micupBotSettingsService').createPanel({
					guildData,
					userId: ctx.get('user').id,
					data: ctx.req.valid('json'),
					requestCache: ctx.get('requestCache'),
				}),
			);
		},
	);
	app.delete(
		'/guilds/:guild_id/micupbot/reaction-roles/:message_id',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdMessageIdParam),
		OpenAPI({
			operationId: 'delete_guild_micupbot_reaction_role',
			summary: 'Delete guild micupbot reaction role',
			description:
				'Delete a reaction role panel belonging to this guild and attempt to remove its bot message. Requires MANAGE_GUILD and the feature. An unknown panel returns 404.',
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
			await ctx.get('micupBotSettingsService').deletePanel({
				guildData,
				userId: ctx.get('user').id,
				messageId: createMessageID(ctx.req.valid('param').message_id),
				requestCache: ctx.get('requestCache'),
			});
			return ctx.body(null, 204);
		},
	);
	app.get(
		'/guilds/:guild_id/micupbot/level-rewards',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_READ),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		OpenAPI({
			operationId: 'list_guild_micupbot_level_rewards',
			summary: 'List guild micupbot level rewards',
			description: 'Read cumulative level rewards. Requires MANAGE_GUILD.',
			responseSchema: MicupBotLevelRewardsResponse,
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
			return ctx.json(await ctx.get('micupBotSettingsService').listRewards({guildData, userId: ctx.get('user').id}));
		},
	);
	app.put(
		'/guilds/:guild_id/micupbot/level-rewards',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		Validator('json', MicupBotLevelRewardsUpdateRequest),
		OpenAPI({
			operationId: 'update_guild_micupbot_level_rewards',
			summary: 'Update guild micupbot level rewards',
			description:
				'Replace at most 25 rewards for distinct levels from 1 through 500. Requires MANAGE_GUILD, MANAGE_ROLES and the feature. All roles must be safe and below the caller and bot.',
			responseSchema: MicupBotLevelRewardsResponse,
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
			await checkPermission(Permissions.MANAGE_ROLES);
			return ctx.json(
				await ctx
					.get('micupBotSettingsService')
					.updateRewards({guildData, userId: ctx.get('user').id, data: ctx.req.valid('json')}),
			);
		},
	);
	app.get(
		'/guilds/:guild_id/micupbot/leaderboard',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_LEADERBOARD),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdParam),
		Validator('query', MicupBotLeaderboardQuery),
		OpenAPI({
			operationId: 'get_guild_micupbot_leaderboard',
			summary: 'Get guild micupbot leaderboard',
			description:
				'Read a page of at most 100 entries from the first 1000 ranked members. Requires guild membership. Disabled levels return an empty leaderboard.',
			responseSchema: MicupBotLeaderboardResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			try {
				await ctx.get('guildService').getGuildAuthenticated({userId: ctx.get('user').id, guildId});
			} catch (error) {
				if (error instanceof UnknownGuildError) throw new MissingAccessError();
				throw error;
			}
			return ctx.json(
				await ctx
					.get('micupBotSettingsService')
					.getLeaderboard({guildId, ...ctx.req.valid('query'), requestCache: ctx.get('requestCache')}),
			);
		},
	);
	app.get(
		'/guilds/:guild_id/micupbot/warnings/:user_id',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_READ),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdUserIdParam),
		OpenAPI({
			operationId: 'list_guild_micupbot_warnings',
			summary: 'List guild micupbot warnings',
			description:
				'Read up to 100 member warnings, newest first. Requires MODERATE_MEMBERS. Moderator identities are visible only to authorized moderators.',
			responseSchema: MicupBotWarningListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const {checkPermission, guildData} = await ctx
				.get('guildService')
				.getGuildAuthenticated({userId: ctx.get('user').id, guildId});
			await checkPermission(Permissions.MODERATE_MEMBERS);
			return ctx.json(
				await ctx.get('micupBotSettingsService').listWarnings({
					guildData,
					userId: ctx.get('user').id,
					targetId: createUserID(ctx.req.valid('param').user_id),
				}),
			);
		},
	);
	app.delete(
		'/guilds/:guild_id/micupbot/warnings/:user_id',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdUserIdParam),
		OpenAPI({
			operationId: 'clear_guild_micupbot_warnings',
			summary: 'Clear guild micupbot warnings',
			description: 'Clear warnings for this guild and member. Requires MODERATE_MEMBERS and the feature.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const {checkPermission, checkTargetMember, guildData} = await ctx
				.get('guildService')
				.getGuildAuthenticated({userId: ctx.get('user').id, guildId});
			await checkPermission(Permissions.MODERATE_MEMBERS);
			await checkTargetMember(createUserID(ctx.req.valid('param').user_id));
			await ctx
				.get('micupBotSettingsService')
				.clearWarnings({guildData, userId: ctx.get('user').id, targetId: createUserID(ctx.req.valid('param').user_id)});
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/guilds/:guild_id/micupbot/warnings/:user_id/:warning_id',
		RateLimitMiddleware(MicupBotRateLimitConfigs.GUILD_MICUPBOT_WRITE),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', GuildIdUserIdWarningIdParam),
		OpenAPI({
			operationId: 'delete_guild_micupbot_warning',
			summary: 'Delete guild micupbot warning',
			description:
				'Delete one warning scoped to this guild and member. Requires MODERATE_MEMBERS and the feature. An unknown warning returns 404.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Guilds'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const guildId = createGuildID(ctx.req.valid('param').guild_id);
			const {checkPermission, checkTargetMember, guildData} = await ctx
				.get('guildService')
				.getGuildAuthenticated({userId: ctx.get('user').id, guildId});
			await checkPermission(Permissions.MODERATE_MEMBERS);
			await checkTargetMember(createUserID(ctx.req.valid('param').user_id));
			await ctx.get('micupBotSettingsService').deleteWarning({
				guildData,
				userId: ctx.get('user').id,
				targetId: createUserID(ctx.req.valid('param').user_id),
				warningId: ctx.req.valid('param').warning_id,
			});
			return ctx.body(null, 204);
		},
	);
}
