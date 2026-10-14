// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminAuditReadActions} from '@app/api/admin/AdminAuditActions';
import {recordAdminRead, recordAdminWrite} from '@app/api/admin/AdminAuditRecorder';
import {createUserID} from '@app/api/BrandedTypes';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {CosmeticRateLimitConfigs} from '@app/api/rate_limit_configs/CosmeticRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {
	AdminUserCosmeticParam,
	CosmeticItemCreateRequest,
	CosmeticItemIdParam,
	CosmeticItemUpdateRequest,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticRequestSchemas';
import {
	AdminUserCosmeticResponse,
	CosmeticItemListResponse,
	CosmeticItemResponse,
} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';

const UPDATABLE_FIELDS = [
	'name',
	'description',
	'availability',
	'asset',
	'ultra_layout',
	'ultra_front',
	'on_sale',
] as const;

export function CosmeticAdminController(app: HonoApp) {
	app.get(
		'/admin/cosmetics/items',
		RateLimitMiddleware(CosmeticRateLimitConfigs.ADMIN_COSMETIC_LIST),
		requireAdminACL(AdminACLs.COSMETICS_MANAGE),
		OpenAPI({
			operationId: 'list_admin_cosmetic_items',
			summary: 'List cosmetic items',
			description:
				'Returns every avatar decoration, ultra decoration, profile effect and nameplate, including items taken off sale (their availability reads owned). Requires COSMETICS_MANAGE permission.',
			responseSchema: CosmeticItemListResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const items = await ctx.get('cosmeticService').listAllItems();
			await recordAdminRead(ctx, {
				targetType: 'cosmetic_item',
				targetId: 0n,
				action: AdminAuditReadActions.LIST_COSMETIC_ITEMS,
				metadata: {result_count: items.length},
			});
			return ctx.json(items);
		},
	);
	app.post(
		'/admin/cosmetics/items',
		RateLimitMiddleware(CosmeticRateLimitConfigs.ADMIN_COSMETIC_MANAGE),
		requireAdminACL(AdminACLs.COSMETICS_MANAGE),
		Validator('json', CosmeticItemCreateRequest),
		OpenAPI({
			operationId: 'create_admin_cosmetic_item',
			summary: 'Create cosmetic item',
			description:
				'Adds an avatar decoration, ultra decoration, profile effect or nameplate to the catalog. The image is stored as a branding asset. Requires COSMETICS_MANAGE permission.',
			responseSchema: CosmeticItemResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const item = await ctx.get('cosmeticService').createItem(ctx.req.valid('json'));
			await recordAdminWrite(ctx, {
				targetType: 'cosmetic_item',
				targetId: BigInt(item.id),
				action: 'create_cosmetic_item',
				metadata: {type: item.type, availability: item.availability},
			});
			return ctx.json(item);
		},
	);
	app.patch(
		'/admin/cosmetics/items/:item_id',
		RateLimitMiddleware(CosmeticRateLimitConfigs.ADMIN_COSMETIC_MANAGE),
		requireAdminACL(AdminACLs.COSMETICS_MANAGE),
		Validator('param', CosmeticItemIdParam),
		Validator('json', CosmeticItemUpdateRequest),
		OpenAPI({
			operationId: 'update_admin_cosmetic_item',
			summary: 'Update cosmetic item',
			description:
				'Changes the name, description, availability or image of a catalog item, the sizes or the in-front images of an ultra decoration (all at once, or null to draw it behind again), or puts an item taken off sale back in the catalog. Accounts that already wear the item keep its main image; in-front images are read from the item, so wearers see a new set. Requires COSMETICS_MANAGE permission.',
			responseSchema: CosmeticItemResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {item_id: itemId} = ctx.req.valid('param');
			const request = ctx.req.valid('json');
			const item = await ctx.get('cosmeticService').updateItem(itemId, request);
			const fields = UPDATABLE_FIELDS.filter((field) => request[field] !== undefined);
			const entry = {
				targetType: 'cosmetic_item',
				targetId: itemId,
				metadata: {fields: fields.join(','), availability: item.availability},
			};
			// Putting an item back on sale is the counterpart of retire_cosmetic_item (DELETE). Other fields sent with it
			// are an update too, so a filter on either action finds the request.
			if (!request.on_sale || fields.length > 1) {
				await recordAdminWrite(ctx, {...entry, action: 'update_cosmetic_item'});
			}
			if (request.on_sale) {
				await recordAdminWrite(ctx, {...entry, action: 'relist_cosmetic_item'});
			}
			return ctx.json(item);
		},
	);
	app.delete(
		'/admin/cosmetics/items/:item_id',
		RateLimitMiddleware(CosmeticRateLimitConfigs.ADMIN_COSMETIC_MANAGE),
		requireAdminACL(AdminACLs.COSMETICS_MANAGE),
		Validator('param', CosmeticItemIdParam),
		OpenAPI({
			operationId: 'delete_admin_cosmetic_item',
			summary: 'Take cosmetic item off sale',
			description:
				'Removes an item from the catalog. The item is not deleted: accounts that wear it keep showing it and accounts that own it can still put it on, while nobody else can. Requires COSMETICS_MANAGE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {item_id: itemId} = ctx.req.valid('param');
			await ctx.get('cosmeticService').retireItem(itemId);
			await recordAdminWrite(ctx, {targetType: 'cosmetic_item', targetId: itemId, action: 'retire_cosmetic_item'});
			return ctx.body(null, 204);
		},
	);
	app.post(
		'/admin/users/:user_id/cosmetics/:item_id',
		RateLimitMiddleware(CosmeticRateLimitConfigs.ADMIN_COSMETIC_MANAGE),
		requireAdminACL(AdminACLs.COSMETICS_MANAGE),
		Validator('param', AdminUserCosmeticParam),
		OpenAPI({
			operationId: 'grant_admin_user_cosmetic',
			summary: 'Give a user a cosmetic item',
			description:
				'Adds the item to the items the account owns, without wearing it. Giving an item the account already owns changes nothing. Requires COSMETICS_MANAGE permission.',
			responseSchema: AdminUserCosmeticResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id: userId, item_id: itemId} = ctx.req.valid('param');
			const result = await ctx.get('cosmeticService').adminGrant(createUserID(userId), itemId);
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: userId,
				action: 'grant_cosmetic_item',
				metadata: {item_id: result.item_id, changed: result.changed},
			});
			return ctx.json(result);
		},
	);
	app.delete(
		'/admin/users/:user_id/cosmetics/:item_id',
		RateLimitMiddleware(CosmeticRateLimitConfigs.ADMIN_COSMETIC_MANAGE),
		requireAdminACL(AdminACLs.COSMETICS_MANAGE),
		Validator('param', AdminUserCosmeticParam),
		OpenAPI({
			operationId: 'revoke_admin_user_cosmetic',
			summary: 'Take a cosmetic item back from a user',
			description:
				'Removes the item from the items the account owns and takes it off if worn; a pending delivery of the item is cancelled so it never comes back. Emits USER_UPDATE when the item was worn. Requires COSMETICS_MANAGE permission.',
			responseSchema: AdminUserCosmeticResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id: userId, item_id: itemId} = ctx.req.valid('param');
			const result = await ctx.get('cosmeticService').adminRevoke(createUserID(userId), itemId);
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: userId,
				action: 'revoke_cosmetic_item',
				metadata: {item_id: result.item_id, changed: result.changed, unequipped: result.unequipped},
			});
			return ctx.json(result);
		},
	);
}
