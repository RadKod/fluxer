// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {followDirectly} from '@app/api/feed/tests/FeedTestUtils';
import {getFollowRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

// the target side of a mutual follow check reads a 60 s KV set of the accounts the
// target follows, never the target's user_following partition per viewer.
describe('the following set cache', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	it("answers whether a user follows a target from a 60 s KV set and drops it on the user's own follow change", async () => {
		const [a, b, c] = await Promise.all([
			createTestAccount(harness),
			createTestAccount(harness),
			createTestAccount(harness),
		]);
		const [aId, bId, cId] = [a, b, c].map((account) => createUserID(BigInt(account.userId)));
		const follows = getFollowRepository();

		expect(await follows.isFollowingCached(aId, bId)).toBe(false); // an empty set ('0') is kept, not read again
		await followDirectly(a.userId, b.userId);
		expect(await follows.isFollowingCached(aId, bId)).toBe(true);
		expect(await follows.isFollowingCached(aId, cId)).toBe(false);

		const row = await follows.getFollow(aId, bId);
		await follows.deleteFollowing(aId, bId, row!.follow_id);
		expect(await follows.isFollowingCached(aId, bId)).toBe(false);
	});
});
