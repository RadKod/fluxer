// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {blockUser, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {captureJobs, createPost, followDirectly, getHome, runFanout} from '@app/api/feed/tests/FeedTestUtils';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getFeedTimelineService, getKVCounterService, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

describe('feed and blocks (Review Focus 5)', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	// Bob follows Alice (they share a community, so Bob may see Alice's profile) and one more account, so a block leaves
	// him a following list and the home feed has to drop Alice's rows itself.
	async function followingPair(): Promise<[alice: TestAccount, bob: TestAccount]> {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		await createBuilder(harness, bob.token)
			.put(`/users/${alice.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await followDirectly(bob.userId, (await getSnowflakeService().generate()).toString());
		return [alice, bob];
	}

	async function expectHiddenFrom(bob: TestAccount, alice: TestAccount, postId: string): Promise<void> {
		expect(await getHome(harness, bob).execute()).toEqual([]);
		await createBuilder(harness, bob.token)
			.get(`/feed/posts/${postId}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
		await createBuilder(harness, bob.token)
			.get(`/users/${alice.userId}/posts`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
	}

	for (const blocker of ['author', 'reader'] as const) {
		it(`drops a fanned-out post from the reader's feed when the ${blocker} blocks`, async () => {
			const [alice, bob] = await followingPair();
			const jobs = captureJobs();
			const post = await createPost(harness, alice, {content: 'engelden önce'}).execute();
			await runFanout(jobs);
			expect((await getHome(harness, bob).execute()).map((entry) => entry.id)).toEqual([post.id]);

			if (blocker === 'author') {
				await blockUser(harness, alice, bob.userId);
			} else {
				await blockUser(harness, bob, alice.userId);
			}

			await expectHiddenFrom(bob, alice, post.id);
		});
	}

	for (const flag of ['DISABLED', 'DELETED'] as const) {
		it(`hides the posts of a ${flag} account from the post, the profile list and the home feed`, async () => {
			const [alice, bob] = await followingPair();
			const jobs = captureJobs();
			const post = await createPost(harness, alice, {content: 'kapatılmadan önce'}).execute();
			await runFanout(jobs);
			expect((await getHome(harness, bob).execute()).map((entry) => entry.id)).toEqual([post.id]);

			const aliceId = createUserID(BigInt(alice.userId));
			const user = (await getUserRepository().findUnique(aliceId))!;
			await getUserRepository().patchUpsert(aliceId, {flags: user.flags | UserFlags[flag]}, user.toRow());

			await expectHiddenFrom(bob, alice, post.id);
		});
	}

	it("drops a pulled celebrity post from the reader's feed after a block", async () => {
		const [alice, bob] = await followingPair();
		await getKVCounterService().add(FOLLOWER_COUNT_COUNTER, alice.userId, 20_000);
		const post = await createPost(harness, alice, {content: 'ünlü, engelden önce'}).execute();
		await getFeedTimelineService().refreshCelebrities();
		expect((await getHome(harness, bob).execute()).map((entry) => entry.id)).toEqual([post.id]);

		await blockUser(harness, alice, bob.userId);

		await expectHiddenFrom(bob, alice, post.id);
	});
});
