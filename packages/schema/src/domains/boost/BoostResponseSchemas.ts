// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const GuildBoostResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the boost'),
	guild_id: SnowflakeStringType.describe('The boosted guild'),
	user: UserPartialResponse.describe('The member who boosts'),
	created_at: z.string().describe('ISO8601 timestamp of when the boost started'),
});

export type GuildBoostResponse = z.infer<typeof GuildBoostResponse>;

export const GuildBoostListResponse = z.array(GuildBoostResponse).describe('Boosts, newest first');

export type GuildBoostListResponse = z.infer<typeof GuildBoostListResponse>;

export const UserBoostSlotResponse = z.object({
	id: z.string().describe('The ID of the boost slot'),
	guild_id: SnowflakeStringType.nullable().describe('The guild the slot boosts, or null when the slot is free'),
	boost_id: SnowflakeStringType.nullable().describe('The boost the slot backs, or null when the slot is free'),
	assigned_at: z.string().nullable().describe('ISO8601 timestamp of when the slot was put on its guild'),
});

export type UserBoostSlotResponse = z.infer<typeof UserBoostSlotResponse>;

export const UserBoostSlotListResponse = z.array(UserBoostSlotResponse).describe('The boost slots of the account');

export type UserBoostSlotListResponse = z.infer<typeof UserBoostSlotListResponse>;
