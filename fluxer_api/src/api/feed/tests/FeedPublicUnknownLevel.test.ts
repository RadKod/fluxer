// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createPost, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getFeedDiscoverRepository, getFeedTimelineService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const HOUR = 3_600_000;

// a public post opens to strangers and Keşfet only while its author's level is "everyone" (100);
// "only me" (101), a level this release does not know and the shared communities and friends levels keep it closed.
describe('public posts of an author whose profile level is not everyone (Kapı 2 Ş2, Ş9)', () => {
	let harness: ApiTestHarness;
	let kv: MockKVProvider;

	beforeAll(async () => {
		harness = await createApiTestHarness();
		kv = harness.kvProvider as MockKVProvider;
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	// A public post through the API (written while the author is public), placed in the Keşfet ranking.
	async function publish(author: TestAccount): Promise<string> {
		await setProfileLevel(author, 100);
		const post = await createPost(harness, author, {content: 'açık'}).execute();
		await getFeedDiscoverRepository().rankPost(BigInt(post.id), 10);
		return post.id;
	}
	// Test accounts are brand new, so the list is built a day ahead (authors >= 24 h, posts still inside 72 h).
	async function build(): Promise<void> {
		await getKVClient().del('feed:discover:build');
		await getFeedTimelineService().discover.buildSnapshot(Date.now() + 25 * HOUR);
	}
	const snapshotIds = async () =>
		(await getFeedDiscoverRepository().getSnapshot())?.entries.map((entry) => entry.post.id) ?? [];
	const ranked = () => kv.zrangebyscore('feed:discover:z', '-inf', '+inf');
	const getPost = (viewer: TestAccount, postId: string) =>
		createBuilder(harness, viewer.token).get(`/feed/posts/${postId}`);

	it.each([101, 57, 0, 1, 2])(
		'a public post of an author at level %i is closed to a stranger and left out of Keşfet',
		async (level) => {
			const [author, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
			const postId = await publish(author);
			await setProfileLevel(author, level);

			await getPost(stranger, postId).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
			await build();
			expect(await snapshotIds()).not.toContain(postId);
			// Skipped, not dead: the author may open their profile again.
			expect(await ranked()).toContain(postId);
		},
	);

	it('a public post of an author at level 100 stays open to a stranger and in Keşfet', async () => {
		const [author, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
		const postId = await publish(author);

		await getPost(stranger, postId).expect(HTTP_STATUS.OK).execute();
		await build();
		expect(await snapshotIds()).toContain(postId);
	});
});
