// SPDX-License-Identifier: AGPL-3.0-or-later

import {MAX_GIFT_CODES_PER_REQUEST} from '@fluxer/constants/src/GiftCodeConstants';
import {ShopSku} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';
import {ShopOrderResponse, ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {
	createStringType,
	Int32Type,
	SnowflakeStringType,
	SnowflakeType,
} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const ShopAdminSettingsResponse = z.object({
	premium_sales_open: z.boolean().describe('Admin switch for premium packages and Visionary'),
	item_sales_open: z.boolean().describe('Admin switch for owned items and bundles'),
	premium_discount_percent: Int32Type.describe('Discount paid premium members get on items and bundles, 0–95'),
	payment_provider_configured: z.boolean().describe('false keeps every sale closed whatever the switches say'),
	visionary_on_sale: z.boolean().describe('Visionary shown and sold, or hidden'),
	visionary_reward_item_ids: z
		.array(SnowflakeStringType)
		.describe('Non-sale cosmetics delivered with every Visionary grant'),
	early_plus_badge_id: SnowflakeStringType.nullable().describe(
		'The catalog badge paid premium and Visionary orders get while Early Plus is open',
	),
	early_plus_open: z.boolean().describe('Paid premium and Visionary orders get the Early Plus badge while true'),
	early_plus_opened_once: z.boolean().describe('Early Plus has opened at least once; its badge can no longer change'),
});

export type ShopAdminSettingsResponse = z.infer<typeof ShopAdminSettingsResponse>;

export const ShopAdminPriceRow = z.object({
	sku: ShopSku,
	base_try_minor: Int32Type.describe('List price in kuruş'),
	campaign_percent: Int32Type.nullable().describe('Campaign discount as stored, ended ones included'),
	campaign_ends_at: z.iso.datetime().nullable(),
	now: ShopPriceResponse.describe('What the shop shows right now, from the one price function'),
});

export type ShopAdminPriceRow = z.infer<typeof ShopAdminPriceRow>;

export const ShopAdminHealth = z
	.object({
		busy_refusals_last_hour: Int32Type.describe('Orders refused with SHOP_BUSY in the current and previous hour'),
		reconcile_lag_seconds: Int32Type.describe('Age of the oldest reconcile slot still waiting; 0 when caught up'),
		provider_backing_off: z.boolean().describe('The payment provider answered 429 in the last 30 seconds'),
	})
	.describe('The temporary payment provider budget triggers, visible to admins');

export type ShopAdminHealth = z.infer<typeof ShopAdminHealth>;

export const ShopAdminBundle = z.object({
	id: SnowflakeStringType.describe('The ID of the bundle'),
	sku: ShopSku.describe('bundle:<id>; priced like any product in prices'),
	name: z.string().describe('The display name of the bundle'),
	description: z.string().nullable().describe('A short description of the bundle'),
	item_ids: z.array(SnowflakeStringType).describe('The items the bundle gives, in bundle order'),
});

export type ShopAdminBundle = z.infer<typeof ShopAdminBundle>;

export const ShopAdminResponse = z.object({
	settings: ShopAdminSettingsResponse,
	prices: z.array(ShopAdminPriceRow),
	health: ShopAdminHealth,
	bundles: z.array(ShopAdminBundle).describe('Every bundle, priced or not, in ID order'),
});

export type ShopAdminResponse = z.infer<typeof ShopAdminResponse>;

export const ShopAdminOrderResponse = ShopOrderResponse.omit({payment_url: true}).extend({
	user_id: SnowflakeStringType.describe('The buyer'),
	provider_order_id: z
		.string()
		.nullable()
		.describe('The payment provider order ID; null until the provider opened the order'),
	provider_status: z.string().nullable().describe('The last payment status the provider reported'),
	paid_at: z.iso.datetime().nullable(),
	granted_at: z.iso.datetime().nullable(),
	check_count: Int32Type.describe('Reconcile checks made, 0–4'),
});

export type ShopAdminOrderResponse = z.infer<typeof ShopAdminOrderResponse>;

export const UpdateShopSettingsRequest = z.object({
	premium_sales_open: z.boolean().optional(),
	item_sales_open: z.boolean().optional(),
	premium_discount_percent: z.number().int().min(0).max(95).optional(),
	visionary_on_sale: z.boolean().optional(),
	visionary_reward_item_ids: z
		.array(SnowflakeType)
		.max(10)
		.optional()
		.describe('Replaces the list; each must be an owned-availability item that is not on sale'),
	early_plus_badge_id: SnowflakeType.nullable()
		.optional()
		.describe('A catalog badge without {n}; null clears it. Fixed once Early Plus has opened. Needs BADGES_MANAGE'),
	early_plus_open: z
		.boolean()
		.optional()
		.describe(
			'true needs BADGES_MANAGE and a badge, and queues the backfill for every earlier paid premium and Visionary buyer',
		),
});

export type UpdateShopSettingsRequest = z.infer<typeof UpdateShopSettingsRequest>;

export const ShopAdminVisionaryResponse = z.object({
	total: Int32Type.describe('Numbered slots'),
	sold: Int32Type.describe('Slots with an owner, revoked numbers included (never resold)'),
	held: Int32Type.describe('Slots held by a pending order whose hold has not ended'),
	remaining: Int32Type.describe('Slots without an owner or a live hold'),
	over_cap_grants: Int32Type.describe('Numbers given above total because payment arrived after the hold ended'),
});

export type ShopAdminVisionaryResponse = z.infer<typeof ShopAdminVisionaryResponse>;

export const SetVisionarySlotsRequest = z.object({
	total: z
		.number()
		.int()
		.min(0)
		.max(100_000)
		.describe('Grows by adding empty slots; shrinking below an owned or held slot is refused'),
});

export type SetVisionarySlotsRequest = z.infer<typeof SetVisionarySlotsRequest>;

export const AdminVisionaryGrantRequest = z.object({
	slot: z.number().int().min(1).max(100_000).optional().describe('A free slot; absent takes the lowest free one'),
});

export type AdminVisionaryGrantRequest = z.infer<typeof AdminVisionaryGrantRequest>;

export const AdminVisionaryResponse = z.object({
	user_id: SnowflakeStringType.describe('The account'),
	slot: Int32Type.nullable().describe('The Visionary number; null when the account has none'),
	lifetime: z.boolean().describe('Whether the account has lifetime premium now'),
	changed: z.boolean().describe('false when the account already was (grant) or was not (revoke) a Visionary'),
});

export type AdminVisionaryResponse = z.infer<typeof AdminVisionaryResponse>;

export const SetShopPricesRequest = z.object({
	prices: z
		.array(
			z.object({
				sku: ShopSku,
				base_try_minor: z
					.number()
					.int()
					.min(100)
					.max(10_000_000)
					.nullable()
					.describe('List price in kuruş, ₺1–₺100 000; null takes the product out of the shop'),
			}),
		)
		.min(1)
		.max(200),
});

export type SetShopPricesRequest = z.infer<typeof SetShopPricesRequest>;

export const ApplyShopCampaignRequest = z.object({
	skus: z.array(ShopSku).min(1).max(200),
	percent: z.number().int().min(1).max(95),
	ends_at: z.iso.datetime().nullable().describe('UTC; null means no end'),
});

export type ApplyShopCampaignRequest = z.infer<typeof ApplyShopCampaignRequest>;

export const RemoveShopCampaignRequest = z.object({skus: z.array(ShopSku).min(1).max(200)});

export type RemoveShopCampaignRequest = z.infer<typeof RemoveShopCampaignRequest>;

export const GenerateCosmeticGiftCodesRequest = z.object({
	count: z.number().int().min(1).max(MAX_GIFT_CODES_PER_REQUEST).describe('How many one-use codes to create'),
	item_id: SnowflakeType.describe('An owned-availability cosmetic item'),
});

export type GenerateCosmeticGiftCodesRequest = z.infer<typeof GenerateCosmeticGiftCodesRequest>;

export const CreateShopBundleRequest = z.object({
	name: createStringType(1, 64).describe('The display name of the bundle (1-64 characters)'),
	description: createStringType(1, 256).nullish().describe('A short description (1-256 characters)'),
	item_ids: z
		.array(SnowflakeType)
		.min(2)
		.max(10)
		.describe(
			'2-10 owned-availability items on sale, in bundle order; repeats are dropped, then 2-10 is checked again',
		),
});

export type CreateShopBundleRequest = z.infer<typeof CreateShopBundleRequest>;

export const UpdateShopBundleRequest = CreateShopBundleRequest.partial();

export type UpdateShopBundleRequest = z.infer<typeof UpdateShopBundleRequest>;

export const ShopBundleIdParam = z.object({
	bundle_id: SnowflakeType.describe('The ID of the bundle'),
});

export type ShopBundleIdParam = z.infer<typeof ShopBundleIdParam>;
