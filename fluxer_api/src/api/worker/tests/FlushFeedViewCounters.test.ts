// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FeedPosts} from '@app/api/feed/FeedTables';
import {
	FEED_LIKE_COUNT_COUNTER,
	FEED_VIEW_COUNT_COUNTER,
	FEED_VIEW_DIRTY_SET,
} from '@app/api/feed/interaction/FeedInteractionCounters';
import {createPost} from '@app/api/feed/tests/FeedTestUtils';
import {
	COUNTER_PARTITIONS,
	counterDirtyKey,
	counterInflightKey,
	counterKey,
	counterPartition,
} from '@app/api/infrastructure/KVCounterService';
import {getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import type {CronScheduler} from '@app/api/worker/CronScheduler';
import {JOBS_STREAM_MAX_AGE_MS} from '@app/api/worker/JetStreamWorkerQueue';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import flushFeedViewCounterSlice from '@app/api/worker/tasks/FlushFeedViewCounterSlice';
import flushFeedViewCounters, {FEED_VIEW_FLUSH_SLICES} from '@app/api/worker/tasks/FlushFeedViewCounters';
import {registerCronJobs} from '@app/api/worker/WorkerMain';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const PARTITIONS_PER_SLICE = 64;
const BUDGET_MS = 45_000;
const BUDGET_WARNING = 'The feed view flush slice used its whole 45 s budget; view counts are falling behind';
const FETCH_POST_ROW_CQL = FeedPosts.selectCql({where: FeedPosts.where.eq('post_id'), limit: 1});

function taskHelpers(overrides: Partial<WorkerTaskHelpers> = {}): WorkerTaskHelpers {
	return {
		logger: new NoopLogger(),
		jobId: 1n,
		addJob: async () => 0n,
		reportProgress: async () => {},
		shouldCancel: async () => false,
		setContextLink: async () => {},
		...overrides,
	};
}

function spyLogger() {
	const logger = new NoopLogger();
	return {logger, info: vi.spyOn(logger, 'info'), warn: vi.spyOn(logger, 'warn'), error: vi.spyOn(logger, 'error')};
}

const range = (from: number, to: number) => Array.from({length: to - from}, (_, index) => from + index);

function viewIdsWhere(count: number, keep: (partition: number) => boolean): Array<string> {
	const ids: Array<string> = [];
	for (let index = 0; ids.length < count; index++) {
		const id = String(1_000_000_000 + index);
		if (keep(counterPartition(FEED_VIEW_COUNT_COUNTER, id))) ids.push(id);
	}
	return ids;
}

describe('feed view counter flush', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.resetData();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	const storedPostRow = (postId: string) => fetchOne<FeedPostRow>(FETCH_POST_ROW_CQL, {post_id: BigInt(postId)});
	const newPost = async () => {
		const author = await createTestAccount(harness);
		return createPost(harness, author, {content: 'görüldü'}).execute();
	};

	it('queues one slice job per 64 partitions each minute with the minute in the payload and the job key', async () => {
		expect(FEED_VIEW_FLUSH_SLICES * PARTITIONS_PER_SLICE).toBe(COUNTER_PARTITIONS);
		const cron = {upsert: vi.fn()};
		registerCronJobs(cron as unknown as CronScheduler, JOBS_STREAM_MAX_AGE_MS);
		expect(cron.upsert).toHaveBeenCalledWith('flushFeedViewCounters', 'flushFeedViewCounters', {}, '0 * * * * *', {
			ledger: false,
		});

		const minute = 29_345_678;
		vi.spyOn(Date, 'now').mockReturnValue(minute * 60_000 + 12_345);
		const addJob = vi.fn(async () => 0n);
		await flushFeedViewCounters({}, taskHelpers({addJob}));

		expect(addJob.mock.calls).toEqual(
			range(0, FEED_VIEW_FLUSH_SLICES).map((slice) => [
				'flushFeedViewCounterSlice',
				{slice, minute},
				{jobKey: `feed-view-flush:${minute}:${slice}`, skipLedger: true},
			]),
		);
	});

	it('a slice flushes only its own partitions of the views set', async () => {
		const counters = getKVCounterService();
		const [inSliceZero] = viewIdsWhere(1, (partition) => partition < PARTITIONS_PER_SLICE);
		const [inSliceOne] = viewIdsWhere(1, (partition) => Math.floor(partition / PARTITIONS_PER_SLICE) === 1);
		for (const id of [inSliceZero!, inSliceOne!]) await counters.add(FEED_VIEW_COUNT_COUNTER, id, 1);
		const flushPartition = vi.spyOn(counters, 'flushPartition');

		await flushFeedViewCounterSlice({slice: 1, minute: 0}, taskHelpers());

		expect(flushPartition.mock.calls.map(([partition]) => partition).sort((a, b) => a - b)).toEqual(
			range(PARTITIONS_PER_SLICE, 2 * PARTITIONS_PER_SLICE),
		);
		expect(flushPartition.mock.calls.every(([, , dirtySet]) => dirtySet === FEED_VIEW_DIRTY_SET)).toBe(true);
		const dirty = (id: string) => counterDirtyKey(counterPartition(FEED_VIEW_COUNT_COUNTER, id), FEED_VIEW_DIRTY_SET);
		expect(await harness.kvProvider.sismember(dirty(inSliceZero!), `${FEED_VIEW_COUNT_COUNTER}:${inSliceZero}`)).toBe(
			1,
		);
		expect(await harness.kvProvider.sismember(dirty(inSliceOne!), `${FEED_VIEW_COUNT_COUNTER}:${inSliceOne}`)).toBe(0);
	});

	it('flushCounters leaves a views backlog alone and finishes', async () => {
		const kv = harness.kvProvider;
		const post = await newPost();
		await getKVCounterService().add(FEED_LIKE_COUNT_COUNTER, post.id, 1);
		// A full batch and one more in one partition, seeded straight into KV (no base reads).
		const partition = counterPartition(FEED_VIEW_COUNT_COUNTER, post.id);
		const ids = viewIdsWhere(1001, (candidate) => candidate === partition);
		for (const id of ids) await kv.set(counterKey(FEED_VIEW_COUNT_COUNTER, id), '5');
		await kv.sadd(
			counterDirtyKey(partition, FEED_VIEW_DIRTY_SET),
			...ids.map((id) => `${FEED_VIEW_COUNT_COUNTER}:${id}`),
		);
		const {logger, warn} = spyLogger();

		await flushCounters({}, taskHelpers({logger}));

		expect((await storedPostRow(post.id))?.like_count).toBe(1);
		expect(await kv.scard(counterDirtyKey(partition, FEED_VIEW_DIRTY_SET))).toBe(1001);
		expect(await kv.scard(counterInflightKey(partition, FEED_VIEW_DIRTY_SET))).toBe(0);
		expect(await kv.ttl(counterKey(FEED_VIEW_COUNT_COUNTER, ids[0]!))).toBe(-1);
		expect(warn).not.toHaveBeenCalled();
	});

	it('every partition of a slice gets at least one batch under a backlog', async () => {
		let now = 1_000_000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		// Every partition always has a full batch, and each batch takes a second: the first round alone is 64 s.
		const flushPartition = vi.spyOn(getKVCounterService(), 'flushPartition').mockImplementation(() => {
			now += 1000;
			return Promise.resolve(1000);
		});
		const {logger, warn} = spyLogger();

		await flushFeedViewCounterSlice({slice: 2, minute: 0}, taskHelpers({logger}));

		expect(flushPartition.mock.calls.map(([partition]) => partition).sort((a, b) => a - b)).toEqual(
			range(2 * PARTITIONS_PER_SLICE, 3 * PARTITIONS_PER_SLICE),
		);
		expect(warn).toHaveBeenCalledWith({slice: 2, flushed: 64_000, ms: 64_000}, BUDGET_WARNING);
	});

	it('no budget warning when the first round runs long but nothing is left', async () => {
		let now = 1_000_000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		// The first round alone is 64 s, but no batch is full, so nothing waits for the next minute.
		vi.spyOn(getKVCounterService(), 'flushPartition').mockImplementation(() => {
			now += 1000;
			return Promise.resolve(5);
		});
		const {logger, info, warn} = spyLogger();

		await flushFeedViewCounterSlice({slice: 2, minute: 0}, taskHelpers({logger}));

		expect(info).toHaveBeenCalledWith({slice: 2, flushed: 320, ms: 64_000}, 'Flushed feed view counters');
		expect(warn).not.toHaveBeenCalled();
	});

	it('one error line per slice when partitions fail, other partitions still flush', async () => {
		const base = 6 * PARTITIONS_PER_SLICE;
		const failing = new Set([base + 1, base + 20, base + 40]);
		const outage = new Error('KV is down');
		vi.spyOn(getKVCounterService(), 'flushPartition').mockImplementation((partition) =>
			failing.has(partition) ? Promise.reject(outage) : Promise.resolve(partition === base + 30 ? 7 : 0),
		);
		const {logger, info, error} = spyLogger();

		await flushFeedViewCounterSlice({slice: 6, minute: 0}, taskHelpers({logger}));

		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith(
			{slice: 6, failed: 3, error: outage},
			'Failed to flush feed view counter partitions; they stay dirty',
		);
		expect(info).toHaveBeenCalledWith({slice: 6, flushed: 7, ms: expect.any(Number)}, 'Flushed feed view counters');
	});

	it('keeps going round the full partitions while there is budget and starts no batch past it', async () => {
		const startedAt = 1_000_000;
		let now = startedAt;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const [first, second] = [3, 10];
		const calls: Array<{partition: number; at: number}> = [];
		vi.spyOn(getKVCounterService(), 'flushPartition').mockImplementation((partition) => {
			calls.push({partition, at: now});
			if (partition !== first && partition !== second) return Promise.resolve(0);
			now += 10_000;
			return Promise.resolve(1000);
		});

		await flushFeedViewCounterSlice({slice: 0, minute: 0}, taskHelpers());

		const batches = (partition: number) => calls.filter((call) => call.partition === partition).length;
		// Rounds end at 20 s, 40 s and 50 s: the third round gives the first partition a batch at 40 s and the second
		// none, as the budget ran out at 45 s.
		expect(batches(first)).toBe(3);
		expect(batches(second)).toBe(2);
		for (const partition of range(0, PARTITIONS_PER_SLICE).filter((p) => p !== first && p !== second)) {
			expect(batches(partition)).toBe(1);
		}
		expect(calls.every((call) => call.at < startedAt + BUDGET_MS)).toBe(true);
	});

	it("starts each minute's round one partition further", async () => {
		const calls: Array<number> = [];
		vi.spyOn(getKVCounterService(), 'flushPartition').mockImplementation((partition) => {
			calls.push(partition);
			return Promise.resolve(0);
		});
		const base = 3 * PARTITIONS_PER_SLICE;

		await flushFeedViewCounterSlice({slice: 3, minute: 63}, taskHelpers());
		expect(calls).toEqual([base + 63, ...range(base, base + 63)]);

		calls.length = 0;
		await flushFeedViewCounterSlice({slice: 3, minute: 64}, taskHelpers());
		expect(calls).toEqual(range(base, base + PARTITIONS_PER_SLICE));
	});

	it('logs slice, flushed and ms for a run with work', async () => {
		const busy = 4 * PARTITIONS_PER_SLICE + 5;
		vi.spyOn(getKVCounterService(), 'flushPartition').mockImplementation((partition) =>
			Promise.resolve(partition === busy ? 7 : 0),
		);
		const withWork = spyLogger();
		await flushFeedViewCounterSlice({slice: 4, minute: 0}, taskHelpers({logger: withWork.logger}));
		expect(withWork.info).toHaveBeenCalledWith(
			{slice: 4, flushed: 7, ms: expect.any(Number)},
			'Flushed feed view counters',
		);
		expect(withWork.warn).not.toHaveBeenCalled();

		const idle = spyLogger();
		await flushFeedViewCounterSlice({slice: 5, minute: 0}, taskHelpers({logger: idle.logger}));
		expect(idle.info).not.toHaveBeenCalled();
	});

	it('a flushed view count lands in feed_posts.view_count', async () => {
		const post = await newPost();
		await getKVCounterService().add(FEED_VIEW_COUNT_COUNTER, post.id, 3);
		const partition = counterPartition(FEED_VIEW_COUNT_COUNTER, post.id);
		const member = `${FEED_VIEW_COUNT_COUNTER}:${post.id}`;
		expect(await harness.kvProvider.sismember(counterDirtyKey(partition), member)).toBe(0);

		await flushFeedViewCounterSlice({slice: Math.floor(partition / PARTITIONS_PER_SLICE), minute: 0}, taskHelpers());

		expect((await storedPostRow(post.id))?.view_count).toBe(3n);
		expect(await harness.kvProvider.sismember(counterDirtyKey(partition, FEED_VIEW_DIRTY_SET), member)).toBe(0);
	});
});
