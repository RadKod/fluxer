// SPDX-License-Identifier: AGPL-3.0-or-later

import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {ShopRateLimitConfigs} from '@app/api/rate_limit_configs/ShopRateLimitConfig';
import {assertShopAvailable} from '@app/api/shop/ShopCatalogService';
import {mapShopOrder} from '@app/api/shop/ShopOrderService';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {CreateShopOrderRequest, ShopOrderIdParam} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';
import {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';

export function ShopOrderController(app: HonoApp) {
	app.post(
		'/shop/orders',
		RateLimitMiddleware(ShopRateLimitConfigs.SHOP_ORDER_CREATE),
		RateLimitMiddleware(ShopRateLimitConfigs.SHOP_ORDER_CREATE_DAY),
		LoginRequired,
		DefaultUserOnly,
		Validator('json', CreateShopOrderRequest),
		OpenAPI({
			operationId: 'create_shop_order',
			summary: 'Start a shop order',
			description:
				'Opens a payment for one product at the Turkish lira price the server computes now and returns the order with its payment page. An unpaid order for the same product and price from the last fifteen minutes is returned instead of a new one. The item or premium time is delivered once the payment provider confirms the payment.',
			responseSchema: ShopOrderResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Premium'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			assertShopAvailable();
			const order = await ctx.get('shopOrderService').createOrder(ctx.get('user'), ctx.req.valid('json').sku);
			return ctx.json(mapShopOrder(order));
		},
	);
	app.get(
		'/shop/orders/:order_id',
		RateLimitMiddleware(ShopRateLimitConfigs.SHOP_ORDER_GET),
		LoginRequired,
		DefaultUserOnly,
		Validator('param', ShopOrderIdParam),
		OpenAPI({
			operationId: 'get_shop_order',
			summary: 'Get a shop order',
			description:
				'Returns one of the current account orders as the server last saw it; it never asks the payment provider. Orders of other accounts answer like unknown ones.',
			responseSchema: ShopOrderResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Premium'],
		}),
		async (ctx) => {
			assertShopAvailable();
			const order = await ctx
				.get('shopOrderService')
				.getOrderForUser(ctx.get('user').id, ctx.req.valid('param').order_id);
			return ctx.json(mapShopOrder(order));
		},
	);
}
