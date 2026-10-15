// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminAuditReadActions} from '@app/api/admin/AdminAuditActions';
import {recordAdminRead, recordAdminWrite} from '@app/api/admin/AdminAuditRecorder';
import type {ShopConfig} from '@app/api/instance/InstanceConfigRepository';
import {hasAdminACL, requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {ShopRateLimitConfigs} from '@app/api/rate_limit_configs/ShopRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {MissingACLError} from '@fluxer/errors/src/domains/core/MissingACLError';
import {
	ApplyShopCampaignRequest,
	CreateShopBundleRequest,
	RemoveShopCampaignRequest,
	SetShopPricesRequest,
	ShopAdminBundle,
	ShopAdminResponse,
	ShopAdminSettingsResponse,
	ShopBundleIdParam,
	UpdateShopBundleRequest,
	UpdateShopSettingsRequest,
} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';

const SETTING_KEYS = [
	'premium_sales_open',
	'item_sales_open',
	'premium_discount_percent',
	'visionary_on_sale',
	'visionary_reward_item_ids',
	'early_plus_badge_id',
	'early_plus_open',
] as const satisfies ReadonlyArray<keyof ShopConfig>;

// <field>_old and <field>_new for every setting the update changed.
function describeSettingsChange(before: ShopConfig, after: ShopConfig): Record<string, string> {
	const metadata: Record<string, string> = {};
	for (const key of SETTING_KEYS) {
		const oldValue = String(before[key]);
		const newValue = String(after[key]);
		if (oldValue === newValue) continue;
		metadata[`${key}_old`] = oldValue;
		metadata[`${key}_new`] = newValue;
	}
	return metadata;
}

const BUNDLE_KEYS = ['name', 'description', 'item_ids'] as const satisfies ReadonlyArray<keyof ShopAdminBundle>;

// <field>_old and <field>_new for every bundle field the update changed; item lists are comma separated.
function describeBundleChange(before: ShopAdminBundle, after: ShopAdminBundle): Record<string, string> {
	const metadata: Record<string, string> = {};
	for (const key of BUNDLE_KEYS) {
		const oldValue = String(before[key]);
		const newValue = String(after[key]);
		if (oldValue === newValue) continue;
		metadata[`${key}_old`] = oldValue;
		metadata[`${key}_new`] = newValue;
	}
	return metadata;
}

export function ShopAdminController(app: HonoApp) {
	app.get(
		'/admin/shop',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_VIEW),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		OpenAPI({
			operationId: 'get_admin_shop',
			summary: 'Get the shop',
			description:
				'Returns the shop settings, every price row with what the shop shows for it now, and the payment provider budget health. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const view = await ctx.get('shopCatalogService').getAdminView();
			await recordAdminRead(ctx, {
				targetType: 'shop',
				targetId: 0n,
				action: AdminAuditReadActions.VIEW_SHOP,
				metadata: {result_count: view.prices.length},
			});
			return ctx.json(view);
		},
	);
	app.patch(
		'/admin/shop/settings',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('json', UpdateShopSettingsRequest),
		OpenAPI({
			operationId: 'update_admin_shop_settings',
			summary: 'Update shop settings',
			description:
				'Opens or closes premium and item sales, sets the premium member discount and the Visionary switches; an omitted field stays as it is. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminSettingsResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const service = ctx.get('shopCatalogService');
			const body = ctx.req.valid('json');
			// Choosing the badge or opening gives a catalog badge to many accounts at once.
			const grantsBadges = body.early_plus_badge_id !== undefined || body.early_plus_open === true;
			if (grantsBadges && !hasAdminACL(ctx.get('adminUserAcls'), AdminACLs.BADGES_MANAGE)) {
				throw new MissingACLError(AdminACLs.BADGES_MANAGE);
			}
			const {before, after} = await service.updateSettings(body);
			const metadata = describeSettingsChange(before, after);
			if (Object.keys(metadata).length > 0) {
				await recordAdminWrite(ctx, {targetType: 'shop', targetId: 0n, action: 'update_shop_settings', metadata});
			}
			// Every open request queues it, so a retry after a failed queue gets one; the minute key keeps it to one a minute.
			if (body.early_plus_open === true && after.early_plus_open) {
				await ctx.get('workerService').addJob(
					'backfillEarlyPlusBadges',
					{},
					{
						jobKey: `backfillEarlyPlusBadges_${Math.floor(Date.now() / 60_000)}`,
						requestedByUserId: ctx.get('adminUserId'),
						requireLedger: true,
					},
				);
			}
			return ctx.json(service.adminSettings(after));
		},
	);
	app.put(
		'/admin/shop/prices',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('json', SetShopPricesRequest),
		OpenAPI({
			operationId: 'set_admin_shop_prices',
			summary: 'Set shop prices',
			description:
				'Sets the list price of up to 200 products in Turkish lira (kuruş); null takes a product out of the shop. Campaigns on the products stay. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const service = ctx.get('shopCatalogService');
			const {prices} = ctx.req.valid('json');
			const changes = await service.setPrices(prices);
			await recordAdminWrite(ctx, {
				targetType: 'shop',
				targetId: 0n,
				action: 'set_shop_prices',
				metadata: {
					count: prices.length,
					skus: prices.map(({sku}) => sku).join(','),
					changes: changes.join(',') || undefined,
				},
			});
			return ctx.json(await service.getAdminView());
		},
	);
	app.post(
		'/admin/shop/campaigns',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('json', ApplyShopCampaignRequest),
		OpenAPI({
			operationId: 'apply_admin_shop_campaign',
			summary: 'Apply a shop campaign',
			description:
				'Puts a 1–95 percent campaign discount on up to 200 priced products until the given time, or with no end. Visionary takes campaigns too; it never takes the premium member discount. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const service = ctx.get('shopCatalogService');
			const request = ctx.req.valid('json');
			const changes = await service.applyCampaign(request);
			await recordAdminWrite(ctx, {
				targetType: 'shop',
				targetId: 0n,
				action: 'apply_shop_campaign',
				metadata: {
					count: request.skus.length,
					percent: request.percent,
					ends_at: request.ends_at,
					changes: changes.join(',') || undefined,
				},
			});
			return ctx.json(await service.getAdminView());
		},
	);
	app.post(
		'/admin/shop/campaigns/remove',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('json', RemoveShopCampaignRequest),
		OpenAPI({
			operationId: 'remove_admin_shop_campaign',
			summary: 'Remove a shop campaign',
			description: 'Ends the campaign discount on up to 200 products now. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const service = ctx.get('shopCatalogService');
			const {skus} = ctx.req.valid('json');
			const changes = await service.removeCampaign(skus);
			await recordAdminWrite(ctx, {
				targetType: 'shop',
				targetId: 0n,
				action: 'remove_shop_campaign',
				metadata: {count: skus.length, changes: changes.join(',') || undefined},
			});
			return ctx.json(await service.getAdminView());
		},
	);
	app.post(
		'/admin/shop/bundles',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('json', CreateShopBundleRequest),
		OpenAPI({
			operationId: 'create_admin_shop_bundle',
			summary: 'Create a shop bundle',
			description:
				'Creates a bundle of 2–10 owned-availability items on sale, sold as the product bundle:<id>; repeated items are dropped. A Visionary reward cannot be in a bundle. The bundle is not in the shop until it gets a price. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminBundle,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const bundle = await ctx.get('shopCatalogService').createBundle(ctx.req.valid('json'));
			await recordAdminWrite(ctx, {
				targetType: 'shop_bundle',
				targetId: BigInt(bundle.id),
				action: 'create_shop_bundle',
				metadata: {name: bundle.name, item_ids: bundle.item_ids.join(',')},
			});
			return ctx.json(bundle);
		},
	);
	app.patch(
		'/admin/shop/bundles/:bundle_id',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('param', ShopBundleIdParam),
		Validator('json', UpdateShopBundleRequest),
		OpenAPI({
			operationId: 'update_admin_shop_bundle',
			summary: 'Update a shop bundle',
			description:
				'Changes the name, description or items of a bundle; an omitted field stays as it is. Orders already open keep the items they were opened with. Requires SHOP_MANAGE permission.',
			responseSchema: ShopAdminBundle,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {bundle_id: bundleId} = ctx.req.valid('param');
			const {before, after} = await ctx.get('shopCatalogService').updateBundle(bundleId, ctx.req.valid('json'));
			await recordAdminWrite(ctx, {
				targetType: 'shop_bundle',
				targetId: bundleId,
				action: 'update_shop_bundle',
				metadata: describeBundleChange(before, after),
			});
			return ctx.json(after);
		},
	);
	app.delete(
		'/admin/shop/bundles/:bundle_id',
		RateLimitMiddleware(ShopRateLimitConfigs.ADMIN_SHOP_MANAGE),
		requireAdminACL(AdminACLs.SHOP_MANAGE),
		Validator('param', ShopBundleIdParam),
		OpenAPI({
			operationId: 'delete_admin_shop_bundle',
			summary: 'Delete a shop bundle',
			description:
				'Deletes a bundle and its price. Orders already open or paid still deliver the items they were opened with. To only take a bundle out of the shop, set its price to null. Requires SHOP_MANAGE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {bundle_id: bundleId} = ctx.req.valid('param');
			const bundle = await ctx.get('shopCatalogService').deleteBundle(bundleId);
			await recordAdminWrite(ctx, {
				targetType: 'shop_bundle',
				targetId: bundleId,
				action: 'delete_shop_bundle',
				metadata: {name: bundle.name},
			});
			return ctx.body(null, 204);
		},
	);
}
