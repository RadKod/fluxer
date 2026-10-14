// SPDX-License-Identifier: AGPL-3.0-or-later

import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const BadgeResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the badge'),
	icon: z.string().describe('Hash of the badge icon'),
	description: z.string().describe('The text shown for the badge'),
});

export type BadgeResponse = z.infer<typeof BadgeResponse>;

export const BadgeListResponse = z.array(BadgeResponse).describe('Every badge in the catalog');

export type BadgeListResponse = z.infer<typeof BadgeListResponse>;
