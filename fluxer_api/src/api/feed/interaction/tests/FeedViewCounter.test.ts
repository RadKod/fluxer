// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FeedPosts} from '@app/api/feed/FeedTables';
import {
	createFeedInteractionCounterFlushers,
	FEED_VIEW_COUNT_COUNTER,
} from '@app/api/feed/interaction/FeedInteractionCounters';
import {createPost} from '@app/api/feed/tests/FeedTestUtils';
import {getFeedInteractionRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const FETCH_POST_ROW_CQL = FeedPosts.selectCql({where: FeedPosts.where.eq('post_id'), limit: 1});

describe('feed post view counter', () => {
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

	const viewCounter = () =>
		createFeedInteractionCounterFlushers(getFeedInteractionRepository()).find(
			(flusher) => flusher.namespace === FEED_VIEW_COUNT_COUNTER,
		)!;
	const storedPostRow = (postId: string) => fetchOne<FeedPostRow>(FETCH_POST_ROW_CQL, {post_id: BigInt(postId)});
	const newPost = async () => {
		const author = await createTestAccount(harness);
		return {author, post: await createPost(harness, author, {content: 'görüldü'}).execute()};
	};

	it('flushes a view count into feed_posts.view_count as a bigint', async () => {
		const {post} = await newPost();

		await viewCounter().flush(post.id, 42);

		expect((await storedPostRow(post.id))?.view_count).toBe(42n);
	});

	it('writes nothing when the stored count is the same', async () => {
		const {post} = await newPost();
		await getFeedInteractionRepository().setPostViewCount(BigInt(post.id), 5n);
		const write = vi.spyOn(getFeedInteractionRepository(), 'setPostViewCount');

		await viewCounter().flush(post.id, 5);

		expect(write).not.toHaveBeenCalled();
		expect((await storedPostRow(post.id))?.view_count).toBe(5n);
	});

	it('clamps a negative value to 0', async () => {
		const {post} = await newPost();
		await getFeedInteractionRepository().setPostViewCount(BigInt(post.id), 5n);

		await viewCounter().flush(post.id, -3);

		expect((await storedPostRow(post.id))?.view_count).toBe(0n);
	});

	it('writes no row for a deleted post', async () => {
		const {author, post} = await newPost();
		await createBuilder(harness, author.token)
			.delete(`/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		await viewCounter().flush(post.id, 3);

		expect(await storedPostRow(post.id)).toBeNull();
	});

	it('reads its base from the row', async () => {
		const {post} = await newPost();
		expect(await viewCounter().readBase(post.id)).toBe(0);

		await getFeedInteractionRepository().setPostViewCount(BigInt(post.id), 7n);

		expect(await viewCounter().readBase(post.id)).toBe(7);
	});

	it('refuses a recount', async () => {
		const {post} = await newPost();

		await expect(viewCounter().recount(post.id)).rejects.toThrow('no recount source');
	});
});
