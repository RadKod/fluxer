// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminAuditReadActions} from '@app/api/admin/AdminAuditActions';
import {recordAdminRead, recordAdminWrite} from '@app/api/admin/AdminAuditRecorder';
import {createUserID} from '@app/api/BrandedTypes';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {getEarlyPlusBadgeService} from '@app/api/middleware/ServiceSingletons';
import type {VisionaryStock} from '@app/api/premium/visionary/VisionaryService';
import {ShopRateLimitConfigs} from '@app/api/rate_limit_configs/ShopRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UserIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {
	AdminVisionaryGrantRequest,
	AdminVisionaryResponse,
	SetVisionarySlotsRequest,
	ShopAdminVisionaryResponse,
} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';

function toVisionaryResponse(stock: VisionaryStock): ShopAdminVisionaryResponse {
	return {
		total: stock.total,
		sold: stock.sold,
		held: stock.held,
		remaining: stock.remaining,
		over_cap_grants: stock.overCapGrants,
	};
}

export function VisionaryAdminController(app: HonoApp) {
	app.get(
		'/admin/shop/visionary',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_VIEW),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		OpenAPI({
			operationId: 'get_admin_shop_visionary',
			summary: 'Get Visionary slots',
			description:
				'Returns how many numbered Visionary slots there are, how many are sold, held by a pending order or free, and how many numbers were given above the total. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminVisionaryResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const stock = await ctx.get('visionaryService').getStock();
			await recordAdminRead(ctx, {
				targetType: 'shop',
				targetId: 0n,
				action: AdminAuditReadActions.VIEW_SHOP_VISIONARY,
				metadata: {total: stock.total},
			});
			return ctx.json(toVisionaryResponse(stock));
		},
	);
	app.put(
		'/admin/shop/visionary/slots',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('json', SetVisionarySlotsRequest),
		OpenAPI({
			operationId: 'set_admin_shop_visionary_slots',
			summary: 'Set Visionary slots',
			description:
				'Sets the number of Visionary slots. Growing adds empty slots; shrinking below an owned or held slot is refused. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminVisionaryResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {totalBefore, stock} = await ctx.get('visionaryService').setTotal(ctx.req.valid('json').total);
			await recordAdminWrite(ctx, {
				targetType: 'shop',
				targetId: 0n,
				action: 'set_visionary_slots',
				metadata: {total_old: totalBefore, total_new: stock.total},
			});
			return ctx.json(toVisionaryResponse(stock));
		},
	);
	app.post(
		'/admin/users/:user_id/visionary',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		requireAdminACL(AdminACLs.USER_UPDATE_FLAGS),
		Validator('param', UserIdParam),
		Validator('json', AdminVisionaryGrantRequest),
		OpenAPI({
			operationId: 'grant_admin_user_visionary',
			summary: 'Make a user a Visionary',
			description:
				'Gives the account a Visionary number, the given free slot or the lowest free one, lifetime premium and the Visionary reward items. An account that already is a Visionary stays as it is. Emits USER_UPDATE. Requires SHOP_MANAGE and USER_UPDATE_FLAGS permissions.',
			responseSchema: AdminVisionaryResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id: userId} = ctx.req.valid('param');
			const result = await ctx.get('visionaryService').adminGrant(createUserID(userId), ctx.req.valid('json').slot);
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: userId,
				action: 'grant_visionary',
				metadata: {slot: result.slot, changed: result.changed, reward_count: result.rewardCount},
			});
			return ctx.json({user_id: userId.toString(), slot: result.slot, lifetime: true, changed: result.changed});
		},
	);
	app.delete(
		'/admin/users/:user_id/visionary',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		requireAdminACL(AdminACLs.USER_UPDATE_FLAGS),
		Validator('param', UserIdParam),
		OpenAPI({
			operationId: 'revoke_admin_user_visionary',
			summary: 'Take Visionary from a user',
			description:
				'Takes the Visionary number, its lifetime premium and the Visionary reward items back from the account. The number is never sold again. Emits USER_UPDATE. Requires SHOP_MANAGE and USER_UPDATE_FLAGS permissions.',
			responseSchema: AdminVisionaryResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id: userId} = ctx.req.valid('param');
			const result = await ctx.get('visionaryService').adminRevoke(createUserID(userId));
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: userId,
				action: 'revoke_visionary',
				metadata: {slot: result.slot, changed: result.changed, rewards_taken_back: result.rewardsTakenBack},
			});
			// After the audit entry, like the premium end: a failed take-back answers 500, and repeating the call takes it back.
			await getEarlyPlusBadgeService().revoke(createUserID(userId));
			return ctx.json({user_id: userId.toString(), slot: result.slot, lifetime: false, changed: result.changed});
		},
	);
}
