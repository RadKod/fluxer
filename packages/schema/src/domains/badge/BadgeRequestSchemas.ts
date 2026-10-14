// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {base64LengthForBytes, createBase64StringType} from '@fluxer/schema/src/primitives/FileValidators';
import {createStringType, SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const BADGE_ICON_MAX_BYTES = 256 * 1024;

export const BadgeIdParam = z.object({
	badge_id: SnowflakeType.describe('The ID of the badge'),
});

export type BadgeIdParam = z.infer<typeof BadgeIdParam>;

export const UserIdBadgeIdParam = UserIdParam.extend(BadgeIdParam.shape);

export type UserIdBadgeIdParam = z.infer<typeof UserIdBadgeIdParam>;

export const BadgeCreateRequest = z.object({
	icon: createBase64StringType(1, base64LengthForBytes(BADGE_ICON_MAX_BYTES)).describe(
		'Base64 PNG, APNG or WebP icon, 256 KB at most',
	),
	description: createStringType(1, 128).describe('The text shown for the badge (1-128 characters)'),
});

export type BadgeCreateRequest = z.infer<typeof BadgeCreateRequest>;

export const BadgeUpdateRequest = BadgeCreateRequest.partial();

export type BadgeUpdateRequest = z.infer<typeof BadgeUpdateRequest>;

export const PioneerBackfillRequest = z.object({
	badge_id: SnowflakeType.describe('The catalog badge whose text carries {n}'),
	first_user_id: SnowflakeType.describe('The account that gets number 1'),
	excluded_user_ids: z.array(SnowflakeType).max(100).describe('Accounts that never get a number'),
	dry_run: z.boolean().optional().describe('Only count the accounts that would get a number'),
});

export type PioneerBackfillRequest = z.infer<typeof PioneerBackfillRequest>;
