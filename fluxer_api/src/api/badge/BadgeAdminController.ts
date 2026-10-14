// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminAuditReadActions} from '@app/api/admin/AdminAuditActions';
import {recordAdminRead, recordAdminWrite} from '@app/api/admin/AdminAuditRecorder';
import {createUserID} from '@app/api/BrandedTypes';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {getPioneerService} from '@app/api/middleware/ServiceSingletons';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {
	BadgeCreateRequest,
	BadgeIdParam,
	BadgeUpdateRequest,
	PioneerBackfillRequest,
	UserIdBadgeIdParam,
} from '@fluxer/schema/src/domains/badge/BadgeRequestSchemas';
import {BadgeListResponse, BadgeResponse} from '@fluxer/schema/src/domains/badge/BadgeResponseSchemas';

export function BadgeAdminController(app: HonoApp) {
	app.get(
		'/admin/badges',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_BADGE_LIST),
		requireAdminACL(AdminACLs.BADGES_MANAGE),
		OpenAPI({
			operationId: 'list_admin_badges',
			summary: 'List badges',
			description: 'Returns every badge in the catalog. Requires BADGES_MANAGE permission.',
			responseSchema: BadgeListResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const badges = await ctx.get('badgeService').listBadges();
			await recordAdminRead(ctx, {
				targetType: 'badge',
				targetId: 0n,
				action: AdminAuditReadActions.LIST_BADGES,
				metadata: {result_count: badges.length},
			});
			return ctx.json(badges);
		},
	);
	app.post(
		'/admin/badges',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_BADGE_UPDATE),
		requireAdminACL(AdminACLs.BADGES_MANAGE),
		Validator('json', BadgeCreateRequest),
		OpenAPI({
			operationId: 'create_admin_badge',
			summary: 'Create badge',
			description: 'Adds a badge with its icon and text to the catalog. Requires BADGES_MANAGE permission.',
			responseSchema: BadgeResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const badge = await ctx.get('badgeService').createBadge(ctx.req.valid('json'));
			await recordAdminWrite(ctx, {
				targetType: 'badge',
				targetId: BigInt(badge.id),
				action: 'create_badge',
				metadata: {icon: badge.icon, description: badge.description},
			});
			return ctx.json(badge);
		},
	);
	app.patch(
		'/admin/badges/:badge_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_BADGE_UPDATE),
		requireAdminACL(AdminACLs.BADGES_MANAGE),
		Validator('param', BadgeIdParam),
		Validator('json', BadgeUpdateRequest),
		OpenAPI({
			operationId: 'update_admin_badge',
			summary: 'Update badge',
			description: 'Changes the icon or text of a badge. Requires BADGES_MANAGE permission.',
			responseSchema: BadgeResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {badge_id} = ctx.req.valid('param');
			const badge = await ctx.get('badgeService').updateBadge(badge_id, ctx.req.valid('json'));
			await recordAdminWrite(ctx, {
				targetType: 'badge',
				targetId: badge_id,
				action: 'update_badge',
				metadata: {icon: badge.icon, description: badge.description},
			});
			return ctx.json(badge);
		},
	);
	app.post(
		'/admin/users/:user_id/badges/:badge_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_USER_BADGE_UPDATE),
		requireAdminACL(AdminACLs.BADGES_MANAGE),
		Validator('param', UserIdBadgeIdParam),
		OpenAPI({
			operationId: 'grant_admin_user_badge',
			summary: 'Give badge to user',
			description: 'Shows the badge on the user profile. Requires BADGES_MANAGE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id, badge_id} = ctx.req.valid('param');
			const userId = createUserID(user_id);
			if (!(await ctx.get('userRepository').findUnique(userId))) throw new UnknownUserError();
			const pioneer = getPioneerService();
			if (await pioneer.isPioneerBadge(badge_id)) await pioneer.regrant(userId, badge_id);
			else await ctx.get('badgeService').grantBadge(userId, badge_id);
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: user_id,
				action: 'grant_user_badge',
				metadata: {badge_id},
			});
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/admin/users/:user_id/badges/:badge_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_USER_BADGE_UPDATE),
		requireAdminACL(AdminACLs.BADGES_MANAGE),
		Validator('param', UserIdBadgeIdParam),
		OpenAPI({
			operationId: 'revoke_admin_user_badge',
			summary: 'Take badge from user',
			description: 'Removes the badge from the user profile. Requires BADGES_MANAGE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id, badge_id} = ctx.req.valid('param');
			const userId = createUserID(user_id);
			const pioneer = getPioneerService();
			let conflict: ConflictError | undefined;
			if (await pioneer.isPioneerBadge(badge_id)) {
				try {
					await pioneer.revoke(userId);
				} catch (error) {
					// revoke drops the row before it gives up on a record that keeps changing: record that, then answer 409.
					if (!(error instanceof ConflictError)) throw error;
					conflict = error;
				}
			} else {
				await ctx.get('badgeService').revokeBadge(userId, badge_id);
			}
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: user_id,
				action: 'revoke_user_badge',
				metadata: {badge_id, record_settled: conflict ? false : undefined},
			});
			if (conflict) throw conflict;
			return ctx.body(null, 204);
		},
	);
	app.post(
		'/admin/badges/pioneer/backfill',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_BADGE_UPDATE),
		requireAdminACL(AdminACLs.BADGES_MANAGE),
		Validator('json', PioneerBackfillRequest),
		OpenAPI({
			operationId: 'start_admin_pioneer_backfill',
			summary: 'Start pioneer numbering',
			description:
				"Numbers the first account 1, then today's eligible accounts by ID, then opens numbering on e-mail verification. Only while numbering is stopped. Requires BADGES_MANAGE permission.",
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const body = ctx.req.valid('json');
			const dryRun = body.dry_run ?? false;
			await getPioneerService().startBackfill({
				badgeId: body.badge_id,
				firstUserId: createUserID(body.first_user_id),
				excludedUserIds: body.excluded_user_ids.map((id) => createUserID(id)),
				dryRun,
				adminUserId: ctx.get('adminUserId'),
				auditLogReason: ctx.get('auditLogReason'),
			});
			await recordAdminWrite(ctx, {
				targetType: 'badge',
				targetId: body.badge_id,
				action: 'start_pioneer_backfill',
				metadata: {first_user_id: body.first_user_id, excluded_count: body.excluded_user_ids.length, dry_run: dryRun},
			});
			return ctx.body(null, 204);
		},
	);
	app.post(
		'/admin/badges/pioneer/stop',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_BADGE_UPDATE),
		requireAdminACL(AdminACLs.BADGES_MANAGE),
		OpenAPI({
			operationId: 'stop_admin_pioneer',
			summary: 'Stop pioneer numbering',
			description: 'Stops numbering new accounts; numbers already given stay. Requires BADGES_MANAGE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			await getPioneerService().stop();
			await recordAdminWrite(ctx, {targetType: 'badge', targetId: 0n, action: 'stop_pioneer', metadata: {}});
			return ctx.body(null, 204);
		},
	);
}
