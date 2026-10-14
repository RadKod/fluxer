// SPDX-License-Identifier: AGPL-3.0-or-later

import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {isPremiumGiftCode} from '@app/api/models/GiftCode';
import {ShopRateLimitConfigs} from '@app/api/rate_limit_configs/ShopRateLimitConfig';
import {assertGiftCodesAvailable} from '@app/api/stripe/services/StripeGiftService';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {UnknownGiftCodeError} from '@fluxer/errors/src/domains/payment/UnknownGiftCodeError';
import {GiftCodeParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {ShopCodeResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';

export function ShopCodeController(app: HonoApp) {
	app.get(
		'/shop/codes/:code',
		RateLimitMiddleware(ShopRateLimitConfigs.SHOP_CODE_GET),
		Validator('param', GiftCodeParam),
		OpenAPI({
			operationId: 'get_shop_code',
			summary: 'Get a code preview',
			description:
				'Returns what a gift code gives: premium time or a cosmetic item. Item codes answer here only; GET /gifts/{code} treats them as unknown. Redeem either kind with POST /gifts/{code}/redeem.',
			responseSchema: ShopCodeResponse,
			statusCode: 200,
			security: [],
			tags: ['Gifts'],
		}),
		async (ctx) => {
			assertGiftCodesAvailable();
			const {code} = ctx.req.valid('param');
			const giftCode = await ctx.get('userRepository').findGiftCode(code);
			if (!giftCode || giftCode.revokedAt) {
				throw new UnknownGiftCodeError();
			}
			let grant: ShopCodeResponse['grant'];
			if (isPremiumGiftCode(giftCode)) {
				grant = {type: 'premium', duration_type: giftCode.durationType, duration_quantity: giftCode.durationQuantity};
			} else {
				const item = await ctx.get('cosmeticService').getItem(giftCode.cosmeticItemId!);
				if (!item) {
					throw new UnknownGiftCodeError();
				}
				grant = {type: 'cosmetic', item};
			}
			const response: ShopCodeResponse = {code: giftCode.code, redeemed: giftCode.redeemedAt !== null, grant};
			return ctx.json(response);
		},
	);
}
