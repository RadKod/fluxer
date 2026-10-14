// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	COSMETIC_GRANT_COLUMNS,
	COSMETIC_ITEM_BY_TYPE_COLUMNS,
	COSMETIC_ITEM_COLUMNS,
	type CosmeticGrantRow,
	type CosmeticItemByTypeRow,
	type CosmeticItemRow,
	USER_COSMETIC_COLUMNS,
	type UserCosmeticRow,
} from '@app/api/database/types/CosmeticTypes';

export const CosmeticItems = defineTable<CosmeticItemRow, 'item_id'>({
	name: 'cosmetic_items',
	columns: COSMETIC_ITEM_COLUMNS,
	primaryKey: ['item_id'],
});
// One partition per cosmetic type, bounded by the admin-curated catalog; readers cache it in process.
export const CosmeticItemsByType = defineTable<CosmeticItemByTypeRow, 'item_type' | 'item_id', 'item_type'>({
	name: 'cosmetic_items_by_type',
	columns: COSMETIC_ITEM_BY_TYPE_COLUMNS,
	primaryKey: ['item_type', 'item_id'],
	partitionKey: ['item_type'],
});
export const UserCosmetics = defineTable<UserCosmeticRow, 'user_id' | 'item_id', 'user_id'>({
	name: 'user_cosmetics',
	columns: USER_COSMETIC_COLUMNS,
	primaryKey: ['user_id', 'item_id'],
	partitionKey: ['user_id'],
});
// Bounded per user: one row per purchase or redeemed code of that account.
export const CosmeticGrants = defineTable<CosmeticGrantRow, 'user_id' | 'grant_key', 'user_id'>({
	name: 'cosmetic_grants',
	columns: COSMETIC_GRANT_COLUMNS,
	primaryKey: ['user_id', 'grant_key'],
	partitionKey: ['user_id'],
});
