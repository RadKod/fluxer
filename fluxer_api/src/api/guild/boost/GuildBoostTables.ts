// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	GUILD_BOOST_COLUMNS,
	GUILD_BOOST_STATE_COLUMNS,
	GUILD_ENTITLEMENT_EXPIRATION_COLUMNS,
	GUILD_PACKAGE_COLUMNS,
	type GuildBoostRow,
	type GuildBoostStateRow,
	type GuildEntitlementExpirationRow,
	type GuildPackageRow,
	USER_BOOST_SLOT_COLUMNS,
	type UserBoostSlotRow,
} from '@app/api/database/types/GuildBoostTypes';

// TEMPORARY: every boost of a guild lives in one partition (about 10^5 rows for the largest guilds, rare writes); a
// recount reads it page by page in the worker. Bucket it by boost id if a guild passes 10^6 boosts.
export const GuildBoosts = defineTable<GuildBoostRow, 'guild_id' | 'boost_id', 'guild_id'>({
	name: 'guild_boosts',
	columns: GUILD_BOOST_COLUMNS,
	primaryKey: ['guild_id', 'boost_id'],
	partitionKey: ['guild_id'],
});
// Slot uniqueness is a version CAS on the user's own partition, never on the guild row.
export const UserBoostSlots = defineTable<UserBoostSlotRow, 'user_id' | 'slot_id', 'user_id'>({
	name: 'user_boost_slots',
	columns: USER_BOOST_SLOT_COLUMNS,
	primaryKey: ['user_id', 'slot_id'],
	partitionKey: ['user_id'],
});
export const GuildBoostState = defineTable<GuildBoostStateRow, 'guild_id'>({
	name: 'guild_boost_state',
	columns: GUILD_BOOST_STATE_COLUMNS,
	primaryKey: ['guild_id'],
});
export const GuildPackages = defineTable<GuildPackageRow, 'guild_id' | 'package_id', 'guild_id'>({
	name: 'guild_packages',
	columns: GUILD_PACKAGE_COLUMNS,
	primaryKey: ['guild_id', 'package_id'],
	partitionKey: ['guild_id'],
});
// Day buckets split into 16 shards (guild_id % 16) so a busy expiry day does not become one hot partition.
export const GuildEntitlementExpirations = defineTable<
	GuildEntitlementExpirationRow,
	'day' | 'shard' | 'guild_id' | 'entitlement_id',
	'day' | 'shard'
>({
	name: 'guild_entitlement_expirations',
	columns: GUILD_ENTITLEMENT_EXPIRATION_COLUMNS,
	primaryKey: ['day', 'shard', 'guild_id', 'entitlement_id'],
	partitionKey: ['day', 'shard'],
});
