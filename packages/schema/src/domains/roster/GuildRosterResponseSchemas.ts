// SPDX-License-Identifier: AGPL-3.0-or-later

import {GUILD_ROSTER_LIMITS} from '@fluxer/schema/src/domains/roster/GuildRosterRequestSchemas';
import {Int32Type, SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const GuildRosterEventResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the roster event'),
	guild_id: SnowflakeStringType.describe('The guild that owns the event'),
	name: z.string().describe('The event name'),
	voice_channel_id: SnowflakeStringType.describe('The event voice channel'),
	announce_channel_id: SnowflakeStringType.describe('The announcement text channel'),
	mention_role_id: SnowflakeStringType.nullable().describe('The role to mention, or null'),
	main_size: Int32Type.describe('The main roster size'),
	sub_size: Int32Type.describe('The substitute roster size'),
	enabled: z.boolean().describe('Whether the event is enabled'),
	created_at: z.string().describe('ISO8601 timestamp of when the event was created'),
	updated_at: z.string().describe('ISO8601 timestamp of when the event was last updated'),
});
export type GuildRosterEventResponse = z.infer<typeof GuildRosterEventResponse>;

export const GuildRosterEventListResponse = z.object({
	feature_enabled: z.boolean().describe('Whether the roster feature and bot are configured'),
	bot: z
		.object({
			application_id: SnowflakeStringType.describe('The official bot application ID'),
			user_id: SnowflakeStringType.describe('The official bot user ID'),
			in_guild: z.boolean().describe('Whether the bot is a member of this guild'),
		})
		.nullable()
		.describe('The configured official bot, or null'),
	invite_permissions: z.literal('17910848').describe('Permissions requested by the official bot invite'),
	max_events: z.literal(GUILD_ROSTER_LIMITS.maxEvents).describe('Maximum roster events per guild'),
	events: z.array(GuildRosterEventResponse).describe('The roster events configured in this guild'),
});
export type GuildRosterEventListResponse = z.infer<typeof GuildRosterEventListResponse>;
