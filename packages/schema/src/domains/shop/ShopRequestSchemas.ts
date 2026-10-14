// SPDX-License-Identifier: AGPL-3.0-or-later

import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const INT64_MAX = 9_223_372_036_854_775_807n;

// Item and bundle IDs are Cassandra bigints: a 19-digit number above int64 would fail to bind and answer 500. A plain
// string, not createStringType: a SKU is an identifier, so " premium:1" is refused instead of trimmed.
export const ShopSku = z
	.string()
	.regex(/^((cosmetic|bundle):[1-9]\d{0,18}|premium:(1|3|12)|visionary)$/)
	.refine((sku) => {
		const id = /^(?:cosmetic|bundle):(\d+)$/.exec(sku)?.[1];
		return id === undefined || BigInt(id) <= INT64_MAX;
	}, 'The ID is above the int64 range')
	.describe(
		'Product: cosmetic:<item_id>, bundle:<bundle_id>, premium:<months> (1, 3 or 12) or visionary (lifetime premium, numbered)',
	);

export type ShopSku = z.infer<typeof ShopSku>;

export const ShopQuoteQuery = z.object({sku: ShopSku});

export type ShopQuoteQuery = z.infer<typeof ShopQuoteQuery>;

// The price never comes from the client.
export const CreateShopOrderRequest = z.object({sku: ShopSku});

export type CreateShopOrderRequest = z.infer<typeof CreateShopOrderRequest>;

export const ShopOrderIdParam = z.object({
	order_id: SnowflakeType.describe('The ID of the shop order'),
});

export type ShopOrderIdParam = z.infer<typeof ShopOrderIdParam>;

// Accepts any string on purpose: a malformed Payriff callback must still get its 200 or 302, so the handler filters
// the order ID itself (digits, int64) and compares the token. The schema exists to document the path.
export const PayriffCallbackParam = z.object({
	order_id: z.string().describe('The ID of the shop order'),
	token: z.string().describe('The callback token of the order'),
});

export type PayriffCallbackParam = z.infer<typeof PayriffCallbackParam>;
