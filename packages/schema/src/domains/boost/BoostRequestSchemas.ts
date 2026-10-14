// SPDX-License-Identifier: AGPL-3.0-or-later

import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {GuildIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {createQueryIntegerType} from '@fluxer/schema/src/primitives/QueryValidators';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const GuildIdBoostIdParam = GuildIdParam.extend({
	boost_id: SnowflakeType.describe('The ID of the boost'),
});

export type GuildIdBoostIdParam = z.infer<typeof GuildIdBoostIdParam>;

// One spelling per slot: a zero-padded alias ("premium:00") would be a second slot row for the same premium slot.
export const PREMIUM_BOOST_SLOT_ID_REGEX = /^premium:(0|[1-9]\d{0,2})$/;

export const GuildBoostCreateRequest = z.object({
	slot_id: z
		.string()
		.regex(PREMIUM_BOOST_SLOT_ID_REGEX, ValidationErrorCodes.INVALID_FORMAT)
		.describe('A free slot from GET /users/@me/boost-slots'),
});

export type GuildBoostCreateRequest = z.infer<typeof GuildBoostCreateRequest>;

export const GuildBoostListQuery = z.object({
	before: SnowflakeType.optional().describe('Return boosts older than this boost ID'),
	limit: createQueryIntegerType({defaultValue: 50, minValue: 1, maxValue: 100}).describe(
		'Maximum number of boosts to return (1-100)',
	),
});

export type GuildBoostListQuery = z.infer<typeof GuildBoostListQuery>;
