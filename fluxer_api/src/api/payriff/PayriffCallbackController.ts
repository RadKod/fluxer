// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {Logger} from '@app/api/Logger';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getShopOrderRepository} from '@app/api/middleware/ServiceSingletons';
import {callbackTokenMatches} from '@app/api/payriff/PayriffCallbackToken';
import {requestShopOrderVerify} from '@app/api/payriff/PayriffVerifyTrigger';
import {ShopRateLimitConfigs} from '@app/api/rate_limit_configs/ShopRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {WebhookReceivedResponse} from '@fluxer/schema/src/domains/premium/PremiumSchemas';
import {PayriffCallbackParam} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';

const INT64_MAX = 9_223_372_036_854_775_807n;
const ORDER_ID_PATTERN = /^[1-9]\d{0,18}$/u;

type PayriffReturnStatus = 'pending' | 'success' | 'cancel';

// Payriff signs nothing and its body is undocumented: only the path's order ID and token are read,
// and a match only queues a check with Payriff. Anything else looks the same from outside: pending, nothing queued.
async function handlePayriffCallback(rawOrderId: string, token: string): Promise<PayriffReturnStatus> {
	if (!ORDER_ID_PATTERN.test(rawOrderId) || BigInt(rawOrderId) > INT64_MAX) return 'pending';
	const orderId = BigInt(rawOrderId);
	try {
		const order = await getShopOrderRepository().find(orderId);
		if (!order || !callbackTokenMatches(token, order.callback_token_hash)) return 'pending';
		if (order.status === 'granted') return 'success';
		if (order.status === 'failed') return 'cancel';
		await requestShopOrderVerify({kvClient: getKVClient(), workerService: getWorkerService()}, orderId, 'callback');
		return order.status === 'paid' ? 'success' : 'pending';
	} catch (error) {
		// Never an error answer: the error log would carry the token in its path. Reconcile still checks the order.
		Logger.warn(
			{orderId: rawOrderId, errorName: error instanceof Error ? error.name : 'unknown'},
			'Payriff callback check failed',
		);
		return 'pending';
	}
}

function returnPageUrl(status: PayriffReturnStatus): string {
	return `${Config.endpoints.webApp.replace(/\/+$/u, '')}/premium-callback?status=${status}`;
}

// PayriffCallbackParam accepts any string, so a malformed callback still gets its 200 or 302; the handler filters the
// order ID itself.
export function PayriffCallbackController(app: HonoApp) {
	app.get(
		'/payriff/callback/:order_id/:token',
		RateLimitMiddleware(ShopRateLimitConfigs.PAYRIFF_CALLBACK),
		Validator('param', PayriffCallbackParam),
		OpenAPI({
			operationId: 'payriff_callback_get',
			summary: 'Return from the Payriff payment page',
			description:
				'The browser lands here after the Payriff payment page. A matching token queues a payment check with Payriff; the browser is then redirected to the premium callback page with status pending, success or cancel and no order detail. Never answers with an error.',
			responseSchema: null,
			statusCode: 302,
			security: [],
			tags: ['Premium'],
		}),
		async (ctx) => {
			const status = await handlePayriffCallback(ctx.req.param('order_id'), ctx.req.param('token'));
			return ctx.redirect(returnPageUrl(status), 302);
		},
	);
	app.post(
		'/payriff/callback/:order_id/:token',
		RateLimitMiddleware(ShopRateLimitConfigs.PAYRIFF_CALLBACK),
		Validator('param', PayriffCallbackParam),
		OpenAPI({
			operationId: 'payriff_callback_post',
			summary: 'Receive a Payriff payment callback',
			description:
				'Payriff calls this when a payment changes. The body is not trusted: a matching token only queues a payment check with Payriff. Always answers 200 with received true, or 303 to the same place when the caller accepts text/html.',
			responseSchema: WebhookReceivedResponse,
			statusCode: 200,
			security: [],
			tags: ['Premium'],
		}),
		async (ctx) => {
			const status = await handlePayriffCallback(ctx.req.param('order_id'), ctx.req.param('token'));
			if (ctx.req.header('accept')?.includes('text/html')) {
				return ctx.redirect(returnPageUrl(status), 303);
			}
			return ctx.json({received: true});
		},
	);
}
