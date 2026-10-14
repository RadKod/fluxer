// SPDX-License-Identifier: AGPL-3.0-or-later

import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {ShopRateLimitConfigs} from '@app/api/rate_limit_configs/ShopRateLimitConfig';
import {formatRateMicro} from '@app/api/shop/ShopPricing';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {ShopQuoteQuery} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';
import {ShopCatalogResponse, ShopQuoteResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';

export function ShopCatalogController(app: HonoApp) {
	app.get(
		'/shop/catalog',
		RateLimitMiddleware(ShopRateLimitConfigs.SHOP_CATALOG),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'get_shop_catalog',
			summary: 'Get the shop catalog',
			description:
				'Returns the priced items, the premium-included items and the premium packages on sale with the shop settings, and Visionary when it is on sale; the same for every account except the viewer block. Only on self-hosted instances in mirror premium mode.',
			responseSchema: ShopCatalogResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Premium'],
		}),
		async (ctx) => ctx.json(await ctx.get('shopCatalogService').getCatalog(ctx.get('user'))),
	);
	app.get(
		'/shop/quote',
		RateLimitMiddleware(ShopRateLimitConfigs.SHOP_QUOTE),
		LoginRequired,
		DefaultUserOnly,
		Validator('query', ShopQuoteQuery),
		OpenAPI({
			operationId: 'get_shop_quote',
			summary: 'Get a shop price quote',
			description:
				'Returns what the current account would pay for one product right now: the list price, the campaign and premium member discounts, the US dollar price and the Azerbaijani manat amount Payriff charges. Refuses products that are not on sale, closed sales and items the account already owns.',
			responseSchema: ShopQuoteResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Premium'],
		}),
		async (ctx) => {
			const {sku, price} = await ctx.get('shopCatalogService').quote(ctx.get('user'), ctx.req.valid('query').sku);
			return ctx.json({
				sku,
				base_usd_cents: price.baseUsdCents,
				campaign_percent: price.campaignPercent,
				premium_percent: price.premiumPercent,
				final_usd_cents: price.finalUsdCents,
				amount_azn_minor: price.amountAznMinor,
				usd_to_azn_rate: formatRateMicro(price.rateMicro),
				usd_to_azn_rate_micro: price.rateMicro,
				currency: 'AZN' as const,
			});
		},
	);
}
