// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import type {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {applyProfileExtensions, registerProfileExtension} from '@app/api/user/profile/ProfileExtensionProviders';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const CONTEXT = {userId: createUserID(1n), viewerId: createUserID(2n), restrictProfile: false, user: {} as User};

function baseProfile(): UserProfileFullResponse {
	return {
		user: {
			id: '1',
			username: 'target',
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		user_profile: {bio: null, pronouns: null, banner: null, accent_color: null},
		guild_member_profile: undefined,
		premium_type: undefined,
		mutual_friends: undefined,
		timezone_offset: null,
		profile_limited: undefined,
	};
}

describe('profile extension providers', () => {
	it('returns the profile exactly as built when no provider is registered', async () => {
		const profile = baseProfile();

		const extended = await applyProfileExtensions(profile, CONTEXT, new Map());

		expect(extended).toStrictEqual(baseProfile());
		expect(Object.keys(extended)).toEqual(Object.keys(baseProfile()));
	});

	it('skips fields a provider leaves undefined and a provider that throws', async () => {
		const extended = await applyProfileExtensions(
			baseProfile(),
			CONTEXT,
			new Map([
				['follow_counts', async () => ({follower_count: 3, following_count: undefined})],
				[
					'badges',
					async () => {
						throw new Error('badge store down');
					},
				],
			]),
		);

		expect(extended).toStrictEqual({...baseProfile(), follower_count: 3});
	});
});

describe('GET /users/:user_id/profile with profile extensions', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('adds registered provider fields and passes the target, viewer and restriction', async () => {
		const target = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await createFriendship(harness, target, viewer);
		const seen: Array<string> = [];
		const unregister = registerProfileExtension('badges', async ({userId, viewerId, restrictProfile}) => {
			seen.push(`${userId}:${viewerId}:${restrictProfile}`);
			return {badges: [{id: '42', icon: 'abc123', description: 'Early supporter'}]};
		});
		try {
			const profile = await createBuilder<UserProfileFullResponse>(harness, viewer.token)
				.get(`/users/${target.userId}/profile`)
				.expect(HTTP_STATUS.OK)
				.execute();

			expect(profile.badges).toEqual([{id: '42', icon: 'abc123', description: 'Early supporter'}]);
			expect(seen).toEqual([`${target.userId}:${viewer.userId}:false`]);
		} finally {
			unregister();
		}
	});
});
