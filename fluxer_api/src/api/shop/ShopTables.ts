// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	SHOP_BUNDLE_COLUMNS,
	SHOP_ORDER_BY_USER_COLUMNS,
	SHOP_ORDER_CHECK_COLUMNS,
	SHOP_ORDER_COLUMNS,
	SHOP_PRICE_COLUMNS,
	type ShopBundleRow,
	type ShopOrderByUserRow,
	type ShopOrderCheckRow,
	type ShopOrderRow,
	type ShopPriceRow,
} from '@app/api/database/types/ShopTypes';

// One partition, bounded by the admin-curated catalog.
export const ShopPrices = defineTable<ShopPriceRow, 'catalog' | 'sku', 'catalog'>({
	name: 'shop_prices',
	columns: SHOP_PRICE_COLUMNS,
	primaryKey: ['catalog', 'sku'],
	partitionKey: ['catalog'],
});
// One partition like the prices, at most 200 bundles.
export const ShopBundles = defineTable<ShopBundleRow, 'catalog' | 'bundle_id', 'catalog'>({
	name: 'shop_bundles',
	columns: SHOP_BUNDLE_COLUMNS,
	primaryKey: ['catalog', 'bundle_id'],
	partitionKey: ['catalog'],
});
export const ShopOrders = defineTable<ShopOrderRow, 'order_id'>({
	name: 'shop_orders',
	columns: SHOP_ORDER_COLUMNS,
	primaryKey: ['order_id'],
});
export const ShopOrdersByUser = defineTable<ShopOrderByUserRow, 'user_id' | 'order_id', 'user_id'>({
	name: 'shop_orders_by_user',
	columns: SHOP_ORDER_BY_USER_COLUMNS,
	primaryKey: ['user_id', 'order_id'],
	partitionKey: ['user_id'],
});
// The reconcile schedule: rows are written with a 7 day TTL (insertWithTtl) and deleted once checked.
export const ShopOrderChecks = defineTable<ShopOrderCheckRow, 'slot' | 'shard' | 'order_id', 'slot' | 'shard'>({
	name: 'shop_order_checks',
	columns: SHOP_ORDER_CHECK_COLUMNS,
	primaryKey: ['slot', 'shard', 'order_id'],
	partitionKey: ['slot', 'shard'],
});
