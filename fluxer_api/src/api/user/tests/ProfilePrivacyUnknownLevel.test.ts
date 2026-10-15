// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

describe('a profile privacy level this release does not know (Kapı 2 Ş9)', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	// A level only a later release writes (100, 101) or anything else, straight into the settings row.
	async function writeLevel(userId: string, level: number): Promise<void> {
		await getUserRepository().patchSettings(createUserID(BigInt(userId)), {profile_privacy: level});
	}

	// T0 knows 100 (everyone; ProfileAccessBonds.test.ts); 101 and an unknown value stay the owner's only.
	it.each([101, 57])('shows level %i only to its owner', async (level) => {
		const owner = await createTestAccount(harness);
		const friend = await createTestAccount(harness);
		await createFriendship(harness, owner, friend);
		await writeLevel(owner.userId, level);

		const profile = await createBuilder<UserProfileFullResponse>(harness, friend.token)
			.get(`/users/${owner.userId}/profile`)
			.execute();
		expect(profile.profile_limited).toBe(true);
		const own = await createBuilder<UserProfileFullResponse>(harness, owner.token)
			.get(`/users/${owner.userId}/profile`)
			.execute();
		expect(own.profile_limited).toBeUndefined();
		await createBuilder(harness, friend.token)
			.get(`/users/${owner.userId}/followers`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
	});

	it('answers the settings route with the stored value', async () => {
		const owner = await createTestAccount(harness);
		await writeLevel(owner.userId, 100);
		const settings = await createBuilder<{profile_privacy: number}>(harness, owner.token)
			.get('/users/@me/settings')
			.execute();
		expect(settings.profile_privacy).toBe(100);
	});
});
