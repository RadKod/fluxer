// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';

type Nullish<T> = T | null;

export type ShopOrderStatus = 'pending' | 'paid' | 'granted' | 'failed' | 'expired';
export type ShopOrderFailureReason = 'amount_mismatch' | 'account_deleted' | 'item_deleted' | 'provider_error';

export interface ShopPriceRow {
	catalog: string; // always SHOP_PRICE_CATALOG
	sku: string;
	// sanalyer: list price in kuruş; the shop sells in Turkish lira only.
	base_try_minor: number;
	campaign_percent: Nullish<number>;
	campaign_ends_at: Nullish<Date>;
	updated_at: Date;
}

// A bundle is sold as the shop_prices row `bundle:<bundle_id>`; its item list is written whole.
export interface ShopBundleRow {
	catalog: string; // always SHOP_PRICE_CATALOG
	bundle_id: bigint;
	name: string;
	description: Nullish<string>;
	item_ids: Array<bigint>;
	created_at: Date;
	updated_at: Date;
}

// A financial record: it stays after account deletion and never holds an email, a name or an IP.
export interface ShopOrderRow {
	order_id: bigint;
	user_id: UserID;
	sku: string;
	item_id: Nullish<bigint>;
	premium_months: Nullish<number>;
	// sanalyer: Turkish lira in kuruş. amount_minor is the price after both discounts, the amount charged.
	base_try_minor: number;
	campaign_percent: number;
	premium_percent: number;
	amount_minor: number;
	currency: string;
	status: ShopOrderStatus;
	failure_reason: Nullish<ShopOrderFailureReason>;
	provider: string;
	provider_order_id: Nullish<string>;
	provider_status: Nullish<string>;
	payment_url: Nullish<string>;
	callback_token_hash: string;
	check_count: number;
	next_check_at: Nullish<Date>;
	created_at: Date;
	updated_at: Date;
	paid_at: Nullish<Date>;
	granted_at: Nullish<Date>;
	version: number;
	// Bundle orders only: the bundle's items frozen when the order opened; delivery reads nothing else.
	item_ids: Nullish<Array<bigint>>;
}

export interface ShopOrderByUserRow {
	user_id: UserID;
	order_id: bigint;
	sku: string;
	created_at: Date;
}

export interface ShopOrderCheckRow {
	slot: number;
	shard: number;
	order_id: bigint;
	due_at: Date;
}

export const SHOP_PRICE_CATALOG = 'default';
// TEMPORARY: 16 shards per 5 minute slot; new rows go to 64 shards, with the reader reading
// both layouts, once a slot partition passes 50 000 rows or the reconcile cursor lags more than 15 minutes.
export const SHOP_ORDER_CHECK_SHARDS = 16;
export const SHOP_ORDER_CHECK_SLOT_MS = 300_000;

export const SHOP_PRICE_COLUMNS = [
	'catalog',
	'sku',
	'base_try_minor',
	'campaign_percent',
	'campaign_ends_at',
	'updated_at',
] as const satisfies ReadonlyArray<keyof ShopPriceRow>;

export const SHOP_BUNDLE_COLUMNS = [
	'catalog',
	'bundle_id',
	'name',
	'description',
	'item_ids',
	'created_at',
	'updated_at',
] as const satisfies ReadonlyArray<keyof ShopBundleRow>;

export const SHOP_ORDER_COLUMNS = [
	'order_id',
	'user_id',
	'sku',
	'item_id',
	'premium_months',
	'base_try_minor',
	'campaign_percent',
	'premium_percent',
	'amount_minor',
	'currency',
	'status',
	'failure_reason',
	'provider',
	'provider_order_id',
	'provider_status',
	'payment_url',
	'callback_token_hash',
	'check_count',
	'next_check_at',
	'created_at',
	'updated_at',
	'paid_at',
	'granted_at',
	'version',
	'item_ids',
] as const satisfies ReadonlyArray<keyof ShopOrderRow>;

export const SHOP_ORDER_BY_USER_COLUMNS = ['user_id', 'order_id', 'sku', 'created_at'] as const satisfies ReadonlyArray<
	keyof ShopOrderByUserRow
>;

export const SHOP_ORDER_CHECK_COLUMNS = ['slot', 'shard', 'order_id', 'due_at'] as const satisfies ReadonlyArray<
	keyof ShopOrderCheckRow
>;
