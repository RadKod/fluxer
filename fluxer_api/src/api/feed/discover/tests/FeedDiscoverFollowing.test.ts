// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import {feedDiscoverCache} from '@app/api/feed/discover/FeedDiscoverCache';
import {
	captureJobs,
	createPost,
	followDirectly,
	getHome,
	runFanout,
	setProfileLevel,
} from '@app/api/feed/tests/FeedTestUtils';
import {FollowRepository} from '@app/api/follow/FollowRepository';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getFeedDiscoverRepository, getFeedTimelineService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {FeedPostListResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;

// author_following on Keşfet pages only, per reader, never in the shared snapshot.
describe('author_following on Keşfet posts', () => {
	let harness: ApiTestHarness;
	const repository = () => getFeedDiscoverRepository();

	// Test accounts are brand new, so the list is built a day ahead (authors >= 24 h, posts still inside 72 h).
	async function build(): Promise<void> {
		await getKVClient().del('feed:discover:build');
		await getFeedTimelineService().discover.buildSnapshot(Date.now() + 25 * HOUR);
		await feedDiscoverCache.refresh();
	}
	async function restartCache(): Promise<void> {
		await feedDiscoverCache.shutdown();
		feedDiscoverCache.resetForTesting();
		feedDiscoverCache.setRefreshSubscriber(getKVClient());
		await feedDiscoverCache.initialize();
	}
	// a public post is written while its author is public.
	async function publish(author: TestAccount, score: number, body: object = {}): Promise<string> {
		await setProfileLevel(author, 100);
		const post = await createPost(harness, author, {content: `puan ${score}`, ...body}).execute();
		await repository().rankPost(BigInt(post.id), score);
		return post.id;
	}
	const discover = (viewer: TestAccount) =>
		createBuilder<FeedPostListResponse>(harness, viewer.token).get('/feed/discover').execute();
	const followingById = async (viewer: TestAccount) =>
		Object.fromEntries((await discover(viewer)).map((post) => [post.id, post.author_following]));
	const accounts = async (count: number) => Promise.all(Array.from({length: count}, () => createTestAccount(harness)));

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
		await restartCache();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	afterAll(async () => {
		await feedDiscoverCache.shutdown();
		await harness?.shutdown();
	});

	it("gives each Discover post author_following for the caller, leaves it off the caller's own posts and out of the snapshot", async () => {
		const [followed, other, viewer] = await accounts(3);
		await followDirectly(viewer!.userId, followed!.userId);
		const fromFollowed = await publish(followed!, 10);
		const fromOther = await publish(other!, 5);
		const own = await publish(viewer!, 1);
		await build();

		const page = await discover(viewer!);
		expect(page.map((post) => post.id)).toEqual([fromFollowed, fromOther, own]);
		expect(page.map((post) => post.author_following)).toEqual([true, false, undefined]);
		expect(page.find((post) => post.id === own)).not.toHaveProperty('author_following');
		// Another reader gets their own answer from the same snapshot.
		expect(await followingById(other!)).toEqual({[fromFollowed]: false, [own]: false, [fromOther]: undefined});

		const snapshot = (await repository().getSnapshot())!;
		expect(snapshot.entries).toHaveLength(3);
		for (const entry of snapshot.entries) expect(entry.post).not.toHaveProperty('author_following');
		for (const entry of feedDiscoverCache.current().entries) expect(entry.post).not.toHaveProperty('author_following');
	});

	it('author_following turns true right after following and false after unfollowing', async () => {
		const [author, viewer] = await accounts(2);
		const postId = await publish(author!, 1);
		await build();
		vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});

		expect(await followingById(viewer!)).toEqual({[postId]: false});
		await createBuilder(harness, viewer!.token)
			.put(`/users/${author!.userId}/follow`)
			.body({post_id: postId})
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await followingById(viewer!)).toEqual({[postId]: true});
		await createBuilder(harness, viewer!.token)
			.delete(`/users/${author!.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await followingById(viewer!)).toEqual({[postId]: false});
	});

	it('home, profile list, post, create and poll vote responses carry no author_following', async () => {
		const [author, viewer] = await accounts(2);
		await createFriendship(harness, author!, viewer!);
		await createBuilder(harness, viewer!.token)
			.put(`/users/${author!.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		const jobs = captureJobs();
		await setProfileLevel(author!, 100);
		const created = await createPost(harness, author!, {
			content: 'anket',
			poll: {options: ['evet', 'hayır'], duration_hours: 24},
		}).execute();
		await runFanout(jobs);
		const responses: Array<FeedPostResponse> = [
			created,
			...(await getHome(harness, viewer!).execute()),
			...(await createBuilder<FeedPostListResponse>(harness, viewer!.token)
				.get(`/users/${author!.userId}/posts`)
				.execute()),
			await createBuilder<FeedPostResponse>(harness, viewer!.token).get(`/feed/posts/${created.id}`).execute(),
			await createBuilder<FeedPostResponse>(harness, viewer!.token)
				.put(`/feed/posts/${created.id}/poll/vote`)
				.body({option: 0})
				.execute(),
		];
		expect(responses.filter((response) => response.id === created.id)).toHaveLength(5);
		for (const response of responses) expect(response).not.toHaveProperty('author_following');
	});

	it("reads the caller's follows once per page, for the page's distinct authors only", async () => {
		const [first, second, viewer] = await accounts(3);
		await publish(first!, 10);
		await publish(first!, 9);
		await publish(second!, 8);
		await publish(viewer!, 7);
		await build();
		const reads = vi.spyOn(FollowRepository.prototype, 'getFollowedAmong');

		const page = await discover(viewer!);
		expect(page).toHaveLength(4);
		expect(reads).toHaveBeenCalledTimes(1);
		const [userId, targetIds] = reads.mock.calls[0]!;
		expect(userId).toBe(createUserID(BigInt(viewer!.userId)));
		expect(targetIds.map(String).sort()).toEqual([first!.userId, second!.userId].sort());
	});
});
