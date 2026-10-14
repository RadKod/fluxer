// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {GuildIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {createStringType, Int32Type, SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const GUILD_ROSTER_LIMITS = {
	maxEvents: 10,
	nameMax: 64,
	mainMin: 1,
	mainMax: 50,
	mainDefault: 10,
	subMin: 0,
	subMax: 25,
	subDefault: 5,
} as const;

const fields = {
	name: createStringType(1, GUILD_ROSTER_LIMITS.nameMax).describe('The event name'),
	voice_channel_id: SnowflakeType.describe('The voice channel used for the event'),
	announce_channel_id: SnowflakeType.describe('The text channel used for announcements'),
	mention_role_id: SnowflakeType.nullish().describe('The role to mention, or null for no mention'),
	main_size: Int32Type.min(GUILD_ROSTER_LIMITS.mainMin)
		.max(GUILD_ROSTER_LIMITS.mainMax)
		.describe('Main roster size (1-50)'),
	sub_size: Int32Type.min(GUILD_ROSTER_LIMITS.subMin)
		.max(GUILD_ROSTER_LIMITS.subMax)
		.describe('Substitute roster size (0-25)'),
	enabled: z.boolean().describe('Whether the event is enabled'),
};

export const GuildRosterEventCreateRequest = z.object({
	...fields,
	main_size: fields.main_size.default(GUILD_ROSTER_LIMITS.mainDefault),
	sub_size: fields.sub_size.default(GUILD_ROSTER_LIMITS.subDefault),
	enabled: fields.enabled.default(true),
});
export type GuildRosterEventCreateRequest = z.infer<typeof GuildRosterEventCreateRequest>;

export const GuildRosterEventUpdateRequest = z
	.object(fields)
	.partial()
	.refine((data) => Object.values(data).some((value) => value !== undefined), {
		message: ValidationErrorCodes.INVALID_FORMAT,
	});
export type GuildRosterEventUpdateRequest = z.infer<typeof GuildRosterEventUpdateRequest>;

export const GuildIdRosterEventIdParam = GuildIdParam.extend({
	event_id: SnowflakeType.describe('The ID of the roster event'),
});
export type GuildIdRosterEventIdParam = z.infer<typeof GuildIdRosterEventIdParam>;
