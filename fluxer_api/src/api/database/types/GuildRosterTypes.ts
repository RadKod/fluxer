// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID, MessageID, RoleID, UserID} from '@app/api/BrandedTypes';
import {ROSTER_CHECK_MINUTE} from '@app/api/guild/roster/GuildRosterConstants';

export interface GuildRosterEventRow {
	guild_id: GuildID;
	event_id: bigint;
	name: string;
	voice_channel_id: ChannelID;
	announce_channel_id: ChannelID;
	mention_role_id: RoleID | null;
	main_size: number;
	sub_size: number;
	enabled: boolean;
	created_by: UserID;
	created_at: Date;
	updated_at: Date;
	version: number;
}

export interface GuildRosterEventBySlotRow {
	slot: number;
	guild_id: GuildID;
	event_id: bigint;
}

export const GUILD_ROSTER_EVENT_COLUMNS = [
	'guild_id',
	'event_id',
	'name',
	'voice_channel_id',
	'announce_channel_id',
	'mention_role_id',
	'main_size',
	'sub_size',
	'enabled',
	'created_by',
	'created_at',
	'updated_at',
	'version',
] as const satisfies ReadonlyArray<keyof GuildRosterEventRow>;
export const GUILD_ROSTER_EVENT_BY_SLOT_COLUMNS = ['slot', 'guild_id', 'event_id'] as const satisfies ReadonlyArray<
	keyof GuildRosterEventBySlotRow
>;

export const ROSTER_SLOT_COUNT = 4096;

export function rosterSlotOf(guildId: GuildID): number {
	return Number((BigInt(guildId) >> 22n) % 4096n);
}

export function rosterHourOf(atMs: number): number {
	return Math.floor(atMs / 3_600_000);
}

export function rosterStartSeconds(hour: number): number {
	return (hour * 3_600_000 + ROSTER_CHECK_MINUTE * 60_000) / 1000;
}

export const rosterKeys = {
	members: (eventId: bigint, hour: number) => `roster:z:${eventId}:${hour}`,
	state: (eventId: bigint, hour: number) => `roster:s:${eventId}:${hour}`,
	message: (messageId: MessageID) => `roster:m:${messageId}`,
	announce: (eventId: bigint, hour: number) => `roster:o:${eventId}:${hour}:announce`,
	warn: (eventId: bigint, hour: number) => `roster:o:${eventId}:${hour}:warn`,
	check: (eventId: bigint, hour: number) => `roster:l:${eventId}:${hour}:check`,
} as const;
