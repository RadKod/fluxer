// SPDX-License-Identifier: AGPL-3.0-or-later

import {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {GiftCodeDurationTypeSchema} from '@fluxer/schema/src/domains/premium/GiftCodeSchemas';
import {ShopSku} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';
import {Int32Type, SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

// sanalyer: every shop amount is Turkish lira in kuruş (1 TL = 100 kuruş); there is no other currency.
export const ShopPriceResponse = z.object({
	base_try_minor: Int32Type.describe('List price in kuruş'),
	campaign_percent: Int32Type.nullable().describe('Active campaign discount; null when none or ended'),
	campaign_ends_at: z.iso.datetime().nullable().describe('When the campaign ends; null when none or open-ended'),
	sale_try_minor: Int32Type.describe('Price after the campaign in kuruş; equals base_try_minor without one'),
	premium_try_minor: Int32Type.nullable().describe(
		'Items and bundles only: what a premium member pays; null when the premium discount is 0, and for packages',
	),
});

export type ShopPriceResponse = z.infer<typeof ShopPriceResponse>;

export const ShopSettingsResponse = z.object({
	premium_sales_open: z.boolean().describe('Admin switch, and a payment provider is configured'),
	item_sales_open: z.boolean().describe('Admin switch, and a payment provider is configured'),
	premium_discount_percent: Int32Type.describe('Discount premium members get on items and bundles, 0–95'),
});

export type ShopSettingsResponse = z.infer<typeof ShopSettingsResponse>;

export const ShopCatalogItemResponse = z.object({
	item: CosmeticItemResponse,
	price: ShopPriceResponse.nullable().describe('null for premium-included items, which are not sold'),
});

export type ShopCatalogItemResponse = z.infer<typeof ShopCatalogItemResponse>;

export const ShopPackageResponse = z.object({
	sku: ShopSku,
	months: z.union([z.literal(1), z.literal(3), z.literal(12)]).describe('Premium time the package adds'),
	price: ShopPriceResponse,
});

export type ShopPackageResponse = z.infer<typeof ShopPackageResponse>;

export const ShopVisionaryResponse = z.object({
	sku: z.literal('visionary'),
	price: ShopPriceResponse.describe(
		'A campaign applies as on any product; premium_try_minor is always null: no premium member discount',
	),
	total: Int32Type.describe('Numbered slots, set by the admin'),
	remaining: Int32Type.describe(
		'Slots without an owner or a live hold; display only, up to 60 s old; order creation decides',
	),
	visible: z
		.boolean()
		.describe('Admin switch (on sale / hidden) and a payment provider configured; false refuses new orders'),
});

export type ShopVisionaryResponse = z.infer<typeof ShopVisionaryResponse>;

export const ShopBundleResponse = z.object({
	sku: ShopSku,
	id: SnowflakeStringType.describe('The ID of the bundle'),
	name: z.string().describe('The display name of the bundle'),
	description: z.string().nullable().describe('A short description of the bundle'),
	items: z
		.array(CosmeticItemResponse)
		.describe('The items the bundle gives, in bundle order; bundle-only items are not in the items list'),
	price: ShopPriceResponse,
});

export type ShopBundleResponse = z.infer<typeof ShopBundleResponse>;

export const ShopCatalogResponse = z.object({
	settings: ShopSettingsResponse,
	items: z
		.array(ShopCatalogItemResponse)
		.describe('Priced owned items and premium-included items on sale, in catalog order'),
	packages: z.array(ShopPackageResponse).describe('Priced premium packages: 1, 3, 12 months'),
	visionary: ShopVisionaryResponse.nullable().describe('null until the admin sets a Visionary price'),
	bundles: z
		.array(ShopBundleResponse)
		.optional()
		.describe('Priced bundles whose items are all owned-availability items on sale'),
	server_time: z.iso.datetime().describe('Server clock, for campaign countdowns'),
	viewer: z
		.object({premium_discount: z.boolean().describe('The viewer pays premium_try_minor: paid premium, not a trial')})
		.describe('Per viewer; everything else is the same for every account and cached'),
});

export type ShopCatalogResponse = z.infer<typeof ShopCatalogResponse>;

export const ShopQuoteResponse = z.object({
	sku: ShopSku,
	base_try_minor: Int32Type.describe('List price in kuruş'),
	campaign_percent: Int32Type.describe('0 when none'),
	premium_percent: Int32Type.describe('0 when not applied'),
	final_try_minor: Int32Type.describe('What the order charges, in kuruş'),
	currency: z.literal('TRY'),
});

export type ShopQuoteResponse = z.infer<typeof ShopQuoteResponse>;

export const ShopOrderStatus = z.enum(['pending', 'paid', 'granted', 'failed', 'expired']);

export type ShopOrderStatus = z.infer<typeof ShopOrderStatus>;

export const ShopOrderResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the shop order'),
	sku: ShopSku,
	status: ShopOrderStatus,
	failure_reason: z
		.enum(['amount_mismatch', 'account_deleted', 'item_deleted', 'provider_error'])
		.nullable()
		.describe('Why a failed order failed; null otherwise'),
	base_try_minor: Int32Type.describe('List price in kuruş'),
	campaign_percent: Int32Type,
	premium_percent: Int32Type,
	final_try_minor: Int32Type.describe('What the order charges, in kuruş'),
	currency: z.literal('TRY'),
	payment_url: z.string().nullable().describe('The payment page; only while pending'),
	created_at: z.iso.datetime(),
	item_ids: z
		.array(SnowflakeStringType)
		.optional()
		.describe('Bundle orders only: the items frozen when the order opened, in bundle order'),
});

export type ShopOrderResponse = z.infer<typeof ShopOrderResponse>;

export const ShopCodeResponse = z.object({
	code: z.string().describe('The code'),
	redeemed: z.boolean().describe('Whether the code has been redeemed'),
	grant: z
		.discriminatedUnion('type', [
			z.object({type: z.literal('premium'), duration_type: GiftCodeDurationTypeSchema, duration_quantity: Int32Type}),
			z.object({type: z.literal('cosmetic'), item: CosmeticItemResponse}),
		])
		.describe('What redeeming the code gives: premium time or a cosmetic item'),
});

export type ShopCodeResponse = z.infer<typeof ShopCodeResponse>;
