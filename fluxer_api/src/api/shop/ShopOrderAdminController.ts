// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminAuditReadActions} from '@app/api/admin/AdminAuditActions';
import {recordAdminRead} from '@app/api/admin/AdminAuditRecorder';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {ShopRateLimitConfigs} from '@app/api/rate_limit_configs/ShopRateLimitConfig';
import {mapShopAdminOrder} from '@app/api/shop/ShopOrderService';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {ShopAdminOrderResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import {ShopOrderIdParam} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';

export function ShopOrderAdminController(app: HonoApp) {
	app.get(
		'/admin/shop/orders/:order_id',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_VIEW),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('param', ShopOrderIdParam),
		OpenAPI({
			operationId: 'get_admin_shop_order',
			summary: 'Get a shop order',
			description:
				'Returns one shop order with its buyer, amounts, Payriff order ID and status, for support and refunds. The Payriff page description carries the same order ID. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminOrderResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const orderId = ctx.req.valid('param').order_id;
			const order = await ctx.get('shopOrderService').getOrderForAdmin(orderId);
			await recordAdminRead(ctx, {
				targetType: 'shop_order',
				targetId: orderId,
				action: AdminAuditReadActions.VIEW_SHOP_ORDER,
				metadata: {order_id: orderId},
			});
			return ctx.json(mapShopAdminOrder(order));
		},
	);
}
