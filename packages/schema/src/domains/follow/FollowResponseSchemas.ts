// SPDX-License-Identifier: AGPL-3.0-or-later

import {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const FollowResponse = z.object({
	id: SnowflakeStringType.describe('The follow ID; its snowflake time is when the follow started'),
	user: UserPartialResponse.describe('The follower in a followers list, the followed user in a following list'),
	is_following: z
		.boolean()
		.optional()
		.describe('Whether the current user follows this account; from the 60 s following list'),
});

export type FollowResponse = z.infer<typeof FollowResponse>;

export const FollowListResponse = z.array(FollowResponse).describe('One page of follows');

export type FollowListResponse = z.infer<typeof FollowListResponse>;
