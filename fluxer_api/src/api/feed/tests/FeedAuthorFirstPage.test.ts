// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FeedRepository} from '@app/api/feed/FeedRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {createSnowflakeFromTimestamp} from '@fluxer/snowflake/src/Snowflake';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const AUTHOR = createUserID(42n);

function row(postId: bigint): FeedPostRow {
	return {
		post_id: postId,
		author_id: AUTHOR,
		content: 'merhaba',
		media: null,
		edited_at: null,
		flags: 0,
		like_count: 0,
		comment_count: 0,
	};
}

// A popular author's first page of post IDs comes from KV for 15 s.
describe("an author's first page of posts in KV", () => {
	let executor: InMemoryCassandraQueryExecutor;
	let repository: FeedRepository;
	let next = Date.now() - 60_000;

	beforeEach(() => {
		executor = new InMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
		repository = new FeedRepository(new MockKVProvider());
	});
	afterEach(() => {
		executor.reset();
		setCassandraQueryExecutorForTesting(null);
		vi.restoreAllMocks();
	});

	async function post(): Promise<bigint> {
		const postId = createSnowflakeFromTimestamp((next += 1000));
		await repository.createPost(row(postId));
		return postId;
	}
	// Reads of the author's index partitions (feed_author_buckets, feed_posts_by_author).
	function indexReads() {
		const spy = vi.spyOn(executor, 'executeQuery');
		return () => spy.mock.calls.filter(([query]) => /feed_author_buckets|feed_posts_by_author/.test(query.cql)).length;
	}

	it('the first page goes to Cassandra once: a second request reads only KV', async () => {
		const ids = [await post(), await post(), await post()].reverse();
		const reads = indexReads();

		expect(await repository.listAuthorPostIds(AUTHOR, {limit: 25})).toEqual(ids);
		const first = reads();
		expect(first).toBeGreaterThan(0);
		expect(await repository.listAuthorPostIds(AUTHOR, {limit: 2})).toEqual(ids.slice(0, 2));
		expect(reads()).toBe(first);
	});

	it('a new post is on the first page at once', async () => {
		const older = await post();
		expect(await repository.listAuthorPostIds(AUTHOR, {limit: 25})).toEqual([older]);
		const newer = await post();
		expect(await repository.listAuthorPostIds(AUTHOR, {limit: 25})).toEqual([newer, older]);
	});

	it('a deleted post drops from the first page at once', async () => {
		const older = await post();
		const newer = await post();
		expect(await repository.listAuthorPostIds(AUTHOR, {limit: 25})).toEqual([newer, older]);
		await repository.deletePost({post_id: newer, author_id: AUTHOR});
		expect(await repository.listAuthorPostIds(AUTHOR, {limit: 25})).toEqual([older]);
	});

	it('a post written while a reader refills the first page is not left out by that refill (CR-O5)', async () => {
		const older = await post(); // its drop marker is up
		// The reader sees the marker and reads the index; a new post lands before the reader writes the page back.
		const execute = executor.executeQuery.bind(executor);
		let newer: bigint | undefined;
		let landed = false;
		vi.spyOn(executor, 'executeQuery').mockImplementation(async (query) => {
			const rows = await execute(query);
			if (!landed && /feed_posts_by_author/.test(query.cql)) {
				landed = true;
				newer = await post();
			}
			return rows;
		});
		expect(await repository.listAuthorPostIds(AUTHOR, {limit: 25})).toEqual([older]);
		expect(await repository.listAuthorPostIds(AUTHOR, {limit: 25})).toEqual([newer, older]);
	});

	it('pages below a cursor are not kept', async () => {
		const ids = [await post(), await post(), await post()].reverse();
		const reads = indexReads();

		expect(await repository.listAuthorPostIds(AUTHOR, {before: ids[0], limit: 25})).toEqual(ids.slice(1));
		const first = reads();
		expect(await repository.listAuthorPostIds(AUTHOR, {before: ids[0], limit: 25})).toEqual(ids.slice(1));
		expect(reads()).toBe(2 * first);
	});
});
