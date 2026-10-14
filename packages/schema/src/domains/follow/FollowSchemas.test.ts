// SPDX-License-Identifier: AGPL-3.0-or-later

import {FollowCreateRequest} from '@fluxer/schema/src/domains/follow/FollowRequestSchemas';
import {describe, expect, it} from 'vitest';

describe('follow request schemas', () => {
	it('takes an empty body, null and an optional snowflake post_id', () => {
		expect(FollowCreateRequest.parse(undefined)).toEqual({});
		expect(FollowCreateRequest.parse(null)).toEqual({});
		expect(FollowCreateRequest.parse({})).toEqual({});
		expect(FollowCreateRequest.parse({post_id: '1790000000000000001'})).toEqual({post_id: 1790000000000000001n});
	});
	it('refuses a post_id that is not a snowflake', () => {
		for (const post_id of ['x', '', '-1', '1.5', '9223372036854775808', null]) {
			expect(FollowCreateRequest.safeParse({post_id}).success).toBe(false);
		}
	});
});
