// SPDX-License-Identifier: AGPL-3.0-or-later

import {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {GiftCodeDurationTypeSchema} from '@fluxer/schema/src/domains/premium/GiftCodeSchemas';
import {ShopSku} from '@fluxer/schema/src/domains/shop/ShopRequestSchemas';
import {
	Int32Type,
	NonNegativeSafeIntegerType,
	SnowflakeStringType,
} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const ShopPriceResponse = z.object({
	base_usd_cents: Int32Type.describe('List price in US cents'),
	campaign_percent: Int32Type.nullable().describe('Active campaign discount; null when none or ended'),
	campaign_ends_at: z.iso.datetime().nullable().describe('When the campaign ends; null when none or open-ended'),
	sale_usd_cents: Int32Type.describe('Price after the campaign; equals base_usd_cents without one'),
	premium_usd_cents: Int32Type.nullable().describe(
		'Items and bundles only: what a premium member pays; null when the premium discount is 0, and for packages',
	),
});

export type ShopPriceResponse = z.infer<typeof ShopPriceResponse>;

export const ShopSettingsResponse = z.object({
	try_rate_expires_at: z.iso
		.datetime()
		.nullish()
		.describe('When the automatic TRY display rate becomes stale; null for a manual override or no effective rate'),
	usd_to_azn_rate_micro: Int32Type.nullish().describe(
		'Exact AZN per USD in millionths for matching the charged amount',
	),
	try_to_azn_rate_micro: Int32Type.nullish().describe(
		'Effective display-only AZN per TRY in millionths; null hides TL',
	),
	try_rate_date: z.iso.date().nullish().describe('CBAR bulletin date; the automatic rate expires after 10 days'),
	premium_sales_open: z.boolean().describe('Admin switch, and Payriff is configured'),
	item_sales_open: z.boolean().describe('Admin switch, and Payriff is configured'),
	premium_discount_percent: Int32Type.describe('Discount premium members get on items and bundles, 0–95'),
	usd_to_azn_rate: z.string().describe('Decimal with four places, e.g. 1.7000; display only'),
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
		'A campaign applies as on any product; premium_usd_cents is always null: no premium member discount',
	),
	total: Int32Type.describe('Numbered slots, set by the admin'),
	remaining: Int32Type.describe(
		'Slots without an owner or a live hold; display only, up to 60 s old; order creation decides',
	),
	visible: z.boolean().describe('Admin switch (on sale / hidden) and Payriff configured; false refuses new orders'),
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
		.object({premium_discount: z.boolean().describe('The viewer pays premium_usd_cents: paid premium, not a trial')})
		.describe('Per viewer; everything else is the same for every account and cached'),
});

export type ShopCatalogResponse = z.infer<typeof ShopCatalogResponse>;

export const ShopQuoteResponse = z.object({
	usd_to_azn_rate_micro: Int32Type.nullish().describe('Exact AZN per USD in millionths used for this amount'),
	sku: ShopSku,
	base_usd_cents: Int32Type,
	campaign_percent: Int32Type.describe('0 when none'),
	premium_percent: Int32Type.describe('0 when not applied'),
	final_usd_cents: Int32Type,
	amount_azn_minor: Int32Type.describe('What Payriff charges, in qepik'),
	usd_to_azn_rate: z.string().describe('Decimal with four places, e.g. 1.7000'),
	currency: z.literal('AZN'),
});

export type ShopQuoteResponse = z.infer<typeof ShopQuoteResponse>;

export const ShopOrderStatus = z.enum(['pending', 'paid', 'granted', 'failed', 'expired']);

export type ShopOrderStatus = z.infer<typeof ShopOrderStatus>;

export const ShopOrderResponse = z.object({
	display_currency: z
		.enum(['TRY', 'AZN'])
		.nullish()
		.describe('Store currency frozen at checkout; null for legacy orders'),
	display_amount_minor: NonNegativeSafeIntegerType.nullish().describe(
		'Store price frozen at checkout, in kuruş or qepik',
	),
	display_rate_micro: Int32Type.nullish().describe('Frozen AZN per TRY in millionths; null for AZN or legacy orders'),
	usd_to_azn_rate_micro: Int32Type.nullish().describe('Exact AZN per USD in millionths used for this amount'),
	id: SnowflakeStringType.describe('The ID of the shop order'),
	sku: ShopSku,
	status: ShopOrderStatus,
	failure_reason: z
		.enum(['amount_mismatch', 'account_deleted', 'item_deleted', 'provider_error'])
		.nullable()
		.describe('Why a failed order failed; null otherwise'),
	base_usd_cents: Int32Type,
	campaign_percent: Int32Type,
	premium_percent: Int32Type,
	final_usd_cents: Int32Type,
	amount_azn_minor: Int32Type.describe('What Payriff charges, in qepik'),
	usd_to_azn_rate: z.string().describe('Decimal with four places, e.g. 1.7000'),
	currency: z.literal('AZN'),
	payment_url: z.string().nullable().describe('The Payriff page; only while pending'),
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
