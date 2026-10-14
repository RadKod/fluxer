// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FeedPosts} from '@app/api/feed/FeedTables';
import {FEED_VIEW_COUNT_COUNTER} from '@app/api/feed/interaction/FeedInteractionCounters';
import {createPost, overrideLimits, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {counterKey} from '@app/api/infrastructure/KVCounterService';
import {getFeedViewService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import flushFeedViewCounterSlice from '@app/api/worker/tasks/FlushFeedViewCounterSlice';
import flushFeedViewCounters from '@app/api/worker/tasks/FlushFeedViewCounters';
import type {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import type {WorkerJobPayload} from '@pkgs/worker/src/contracts/WorkerTypes';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const FETCH_POST_ROW_CQL = FeedPosts.selectCql({where: FeedPosts.where.eq('post_id'), limit: 1});
const FLUSHED_COUNTER_TTL_MS = 86_400_000;

// route → process buffer → KV counter → views lane cron → slice jobs → feed_posts.view_count.
describe('feed view pipeline, end to end', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.resetData();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	const getPost = (viewer: TestAccount, postId: string) =>
		createBuilder<FeedPostResponse>(harness, viewer.token).get(`/feed/posts/${postId}`).execute();
	const storedPostRow = (postId: string) => fetchOne<FeedPostRow>(FETCH_POST_ROW_CQL, {post_id: BigInt(postId)});

	// The minute cron queues the slice jobs; each is run here as the views lane would run it.
	async function runViewsLane(): Promise<void> {
		const queued: Array<WorkerJobPayload> = [];
		const helpers: WorkerTaskHelpers = {
			logger: new NoopLogger(),
			jobId: 1n,
			addJob: async (task, payload) => {
				if (task === 'flushFeedViewCounterSlice') queued.push(payload);
				return 0n;
			},
			reportProgress: async () => {},
			shouldCancel: async () => false,
			setContextLink: async () => {},
		};
		await flushFeedViewCounters({}, helpers);
		expect(queued.length).toBeGreaterThan(0);
		for (const payload of queued) await flushFeedViewCounterSlice(payload, helpers);
	}

	async function viewedPost(): Promise<string> {
		overrideLimits({feature_feed_views: 1});
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await setProfileLevel(author, 100);
		const {id} = await createPost(harness, author, {content: 'uçtan uca', public: true}).execute();
		const seen = await getPost(viewer, id);

		await createBuilder(harness, viewer.token)
			.post('/feed/views')
			.body({views: [{id, token: seen.view_token!}]})
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await getFeedViewService().flush();
		await runViewsLane();
		return id;
	}

	it('a view recorded through the route reaches feed_posts.view_count after the views flush', async () => {
		const postId = await viewedPost();

		expect((await storedPostRow(postId))?.view_count).toBe(1n);
	});

	it('the count stays after its KV key is gone (read from the row)', async () => {
		const postId = await viewedPost();
		// A flushed counter key lives 24 h; by then the 60 s post cache has long let go of the row read before the flush.
		vi.useFakeTimers({toFake: ['Date'], now: Date.now() + FLUSHED_COUNTER_TTL_MS + 1000});
		const reader = await createTestAccount(harness);

		expect(await harness.kvProvider.get(counterKey(FEED_VIEW_COUNT_COUNTER, postId))).toBeNull();
		expect((await getPost(reader, postId)).view_count).toBe(1);
	});
});
