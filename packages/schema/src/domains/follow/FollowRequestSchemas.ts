// SPDX-License-Identifier: AGPL-3.0-or-later

import {createQueryIntegerType} from '@fluxer/schema/src/primitives/QueryValidators';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const FollowPageLimit = createQueryIntegerType({defaultValue: 50, minValue: 1, maxValue: 100}).describe(
	'Maximum number of entries to return (1-100)',
);

export const FollowersQuery = z.object({
	before: SnowflakeType.optional().describe('Return followers who followed before this follow ID'),
	limit: FollowPageLimit,
});

export type FollowersQuery = z.infer<typeof FollowersQuery>;

export const FollowingQuery = z.object({
	after: SnowflakeType.optional().describe('Return followed users with IDs above this user ID'),
	limit: FollowPageLimit,
});

export type FollowingQuery = z.infer<typeof FollowingQuery>;

// Micup akis-takip: an optional body; an empty one follows under the profile rule as before (S-2).
export const FollowCreateRequest = z.preprocess(
	(value) => value ?? {},
	z.object({
		post_id: SnowflakeType.optional().describe(
			'A public post of this user that Discover lists now; lets a caller without access to the profile follow its author',
		),
	}),
);

export type FollowCreateRequest = z.infer<typeof FollowCreateRequest>;
