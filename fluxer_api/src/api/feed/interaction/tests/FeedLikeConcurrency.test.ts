// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FeedPosts} from '@app/api/feed/FeedTables';
import {FEED_LIKE_COUNT_COUNTER} from '@app/api/feed/interaction/FeedInteractionCounters';
import {createPost} from '@app/api/feed/tests/FeedTestUtils';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getFeedInteractionService, getFeedRepository, getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import type {FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const LIKERS = 500;

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

describe('feed like counter under concurrent likes', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('counts 500 concurrent likes, and a repeated like once, into the KV counter and feed_posts.like_count', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'viral'}).execute();
		const row = (await getFeedRepository().getPost(BigInt(post.id)))!;
		const likers = await Promise.all(
			Array.from({length: LIKERS}, async () => createUserID(await getSnowflakeService().generate())),
		);
		const service = getFeedInteractionService();

		// Every account likes twice at once; only one of each pair creates a like.
		const created = await Promise.all(
			likers.flatMap((userId) => [service.likePost(userId, row), service.likePost(userId, row)]),
		);
		expect(created.filter(Boolean)).toHaveLength(LIKERS);
		expect(await getKVCounterService().get(FEED_LIKE_COUNT_COUNTER, post.id)).toBe(LIKERS);

		await flushCounters({}, helpers);
		const stored = await fetchOne<FeedPostRow>(FeedPosts.selectCql({where: FeedPosts.where.eq('post_id'), limit: 1}), {
			post_id: BigInt(post.id),
		});
		expect(stored?.like_count).toBe(LIKERS);
		expect(await service.deps.repository.listLikerIds(BigInt(post.id), {limit: 100})).toHaveLength(100);
		expect(
			await createBuilder<FeedPostResponse>(harness, alice.token).get(`/feed/posts/${post.id}`).execute(),
		).toMatchObject({like_count: LIKERS, liked: false});

		// With the KV counters (and the 60 s post cache) gone, the response falls back to the flushed row.
		for (const pattern of ['counter:*', 'feed:post:*']) {
			await harness.kvProvider.del(...(await harness.kvProvider.scan(pattern, 1_000_000)));
		}
		expect(
			await createBuilder<FeedPostResponse>(harness, alice.token).get(`/feed/posts/${post.id}`).execute(),
		).toMatchObject({like_count: LIKERS});
	});
});
