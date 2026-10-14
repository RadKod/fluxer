// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	BADGE_CATALOG_COLUMNS,
	BADGE_COLUMNS,
	type BadgeCatalogRow,
	type BadgeRow,
	PIONEER_BY_USER_COLUMNS,
	PIONEER_SLOT_COLUMNS,
	PIONEER_STATE_COLUMNS,
	type PioneerByUserRow,
	type PioneerSlotRow,
	type PioneerStateRow,
	USER_BADGE_COLUMNS,
	type UserBadgeRow,
} from '@app/api/database/types/BadgeTypes';

export const Badges = defineTable<BadgeRow, 'badge_id'>({
	name: 'badges',
	columns: BADGE_COLUMNS,
	primaryKey: ['badge_id'],
});
// TEMPORARY: one catalog partition (catalog = 0) bounded by the admin-curated badge list and read through a process
// cache; shard it by catalog number if the list ever passes 10 000 badges.
export const BadgeCatalog = defineTable<BadgeCatalogRow, 'catalog' | 'badge_id', 'catalog'>({
	name: 'badge_catalog',
	columns: BADGE_CATALOG_COLUMNS,
	primaryKey: ['catalog', 'badge_id'],
	partitionKey: ['catalog'],
});
export const UserBadges = defineTable<UserBadgeRow, 'user_id' | 'badge_id', 'user_id'>({
	name: 'user_badges',
	columns: USER_BADGE_COLUMNS,
	primaryKey: ['user_id', 'badge_id'],
	partitionKey: ['user_id'],
});
export const PioneerSlots = defineTable<PioneerSlotRow, 'slot'>({
	name: 'pioneer_slots',
	columns: PIONEER_SLOT_COLUMNS,
	primaryKey: ['slot'],
});
export const PioneerByUser = defineTable<PioneerByUserRow, 'user_id'>({
	name: 'pioneer_by_user',
	columns: PIONEER_BY_USER_COLUMNS,
	primaryKey: ['user_id'],
});
// One row (id = 0), written at most once per number plus the admin state changes; KV and a process cache keep reads off it.
export const PioneerState = defineTable<PioneerStateRow, 'id'>({
	name: 'pioneer_state',
	columns: PIONEER_STATE_COLUMNS,
	primaryKey: ['id'],
});
