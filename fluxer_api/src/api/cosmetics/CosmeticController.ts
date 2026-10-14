// SPDX-License-Identifier: AGPL-3.0-or-later

import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {CosmeticRateLimitConfigs} from '@app/api/rate_limit_configs/CosmeticRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {
	CosmeticCatalogQuery,
	CosmeticItemIdsQuery,
	EquipCosmeticsRequest,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticRequestSchemas';
import {
	CosmeticCatalogResponse,
	CosmeticItemListResponse,
	EquippedCosmeticsResponse,
	UserCosmeticsResponse,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';

export function CosmeticController(app: HonoApp) {
	app.get(
		'/cosmetics/catalog',
		RateLimitMiddleware(CosmeticRateLimitConfigs.COSMETIC_CATALOG),
		LoginRequired,
		DefaultUserOnly,
		Validator('query', CosmeticCatalogQuery),
		OpenAPI({
			operationId: 'list_cosmetic_catalog',
			summary: 'List cosmetic catalog',
			description:
				'Returns the avatar decorations, ultra decorations, profile effects and nameplates on offer, optionally of one type, with who can wear each.',
			responseSchema: CosmeticCatalogResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => ctx.json(await ctx.get('cosmeticService').listCatalog(ctx.req.valid('query').type)),
	);
	app.get(
		'/cosmetics/items',
		RateLimitMiddleware(CosmeticRateLimitConfigs.COSMETIC_ITEMS),
		LoginRequired,
		DefaultUserOnly,
		Validator('query', CosmeticItemIdsQuery),
		OpenAPI({
			operationId: 'list_cosmetic_items_by_id',
			summary: 'List cosmetic items by ID',
			description:
				'Returns up to 50 cosmetic items by ID, items taken off sale included, so clients can draw what other accounts wear, such as ultra decoration sizes. Unknown IDs are left out.',
			responseSchema: CosmeticItemListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => {
			const ids = ctx.req.valid('query').ids.split(',').map(BigInt);
			return ctx.json(await ctx.get('cosmeticService').getItemsByIds(ids));
		},
	);
	app.get(
		'/users/@me/cosmetics',
		RateLimitMiddleware(CosmeticRateLimitConfigs.COSMETIC_LIST_OWN),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'list_my_cosmetics',
			summary: 'List my cosmetics',
			description: 'Returns the cosmetic items the current user owns and the ones they wear.',
			responseSchema: UserCosmeticsResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => ctx.json(await ctx.get('cosmeticService').listOwn(ctx.get('user'))),
	);
	app.put(
		'/users/@me/cosmetics/equipped',
		RateLimitMiddleware(CosmeticRateLimitConfigs.COSMETIC_EQUIP),
		LoginRequired,
		DefaultUserOnly,
		Validator('json', EquipCosmeticsRequest),
		OpenAPI({
			operationId: 'update_my_equipped_cosmetics',
			summary: 'Wear or take off cosmetics',
			description:
				'Sets the avatar decoration, ultra decoration, profile effect and nameplate the current user wears; null takes one off and an omitted field stays as it is. Only free items, premium items for premium accounts and owned items can be worn. Emits USER_UPDATE.',
			responseSchema: EquippedCosmeticsResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			return ctx.json(await ctx.get('cosmeticService').equip(ctx.get('user'), ctx.req.valid('json')));
		},
	);
}
