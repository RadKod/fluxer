// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	GUILD_ROSTER_EVENT_BY_SLOT_COLUMNS,
	GUILD_ROSTER_EVENT_COLUMNS,
	type GuildRosterEventBySlotRow,
	type GuildRosterEventRow,
} from '@app/api/database/types/GuildRosterTypes';

export const GuildRosterEvents = defineTable<GuildRosterEventRow, 'guild_id' | 'event_id', 'guild_id'>({
	name: 'guild_roster_events',
	columns: GUILD_ROSTER_EVENT_COLUMNS,
	primaryKey: ['guild_id', 'event_id'],
	partitionKey: ['guild_id'],
});

// TEMPORARY: 4096 slot partitions; above 5000 rows per slot on average, move to a new 16384-slot table.
export const GuildRosterEventsBySlot = defineTable<GuildRosterEventBySlotRow, 'slot' | 'guild_id' | 'event_id', 'slot'>(
	{
		name: 'guild_roster_events_by_slot',
		columns: GUILD_ROSTER_EVENT_BY_SLOT_COLUMNS,
		primaryKey: ['slot', 'guild_id', 'event_id'],
		partitionKey: ['slot'],
	},
);
