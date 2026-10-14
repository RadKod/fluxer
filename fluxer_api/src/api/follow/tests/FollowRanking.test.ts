// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import type {PreparedQuery} from '@app/api/database/CassandraTypes';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {FollowRepository} from '@app/api/follow/FollowRepository';
import {counterDirtyKey, counterPartition} from '@app/api/infrastructure/KVCounterService';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getFollowRepository, getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {onUserBanned} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {computeHashSlot} from '@pkgs/kv_client/src/KVHashSlots';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const RANK_KEY = 'follow:rank:{rank}:followers';
const FLOOR_KEY = 'follow:rank:{rank}:floor';
const FILLED_KEY = 'follow:rank:{rank}:filled';
const BACKFILL_KEY = 'follow:rank:{rank}:backfill';

// Only Date is faked and it only moves when a test moves it; every test starts a minute after the last one, so the
// flusher's 10 s floor read from an earlier test never carries over.
let clock = Date.now();
let lastId = 7_000_000_000n;
const nextId = (): string => String(++lastId);
const uid = (id: string): UserID => createUserID(BigInt(id));
const ranked = (): Promise<Array<string>> => getKVClient().zrangebyscore(RANK_KEY, '-inf', '+inf');
const rankedAt = (count: number): Promise<Array<string>> => getKVClient().zrangebyscore(RANK_KEY, -count, -count);
const advance = (ms: number): void => void vi.setSystemTime(Date.now() + ms);

async function flush(id: string): Promise<void> {
	await getKVCounterService().flushPartition(counterPartition(FOLLOWER_COUNT_COUNTER, id), 1000);
}

async function setFollowers(id: string, delta: number): Promise<void> {
	await getKVCounterService().add(FOLLOWER_COUNT_COUNTER, id, delta);
}

// The in-memory executor answers a paged read with its first page and no page state; the backfill scan needs real pages.
class PagedInMemoryExecutor extends InMemoryCassandraQueryExecutor {
	async executePagedQuery<T>(query: PreparedQuery, options: {pageSize: number; pageState?: string | null}) {
		const rows = await this.executeQuery<T>(query);
		const offset = Number(options.pageState ?? 0);
		const next = offset + options.pageSize;
		return {rows: rows.slice(offset, next), pageState: next < rows.length ? String(next) : null};
	}
}

describe('follower ranking for the feed suggestions', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		clock += 60_000;
		vi.useFakeTimers({now: clock, toFake: ['Date']});
		await getKVClient().del(RANK_KEY, FLOOR_KEY, FILLED_KEY, BACKFILL_KEY);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	it('ranks an account by follower count on the counter flush once the count reaches the floor, after writing the stored base', async () => {
		const setStat = vi.spyOn(FollowRepository.prototype, 'setStat');
		const rank = vi.spyOn(FollowRepository.prototype, 'rankFollowers');
		await getKVClient().setex(FLOOR_KEY, 600, '2');
		const id = nextId();

		await setFollowers(id, 2);
		await flush(id);
		expect(await rankedAt(2)).toEqual([id]);
		expect((await getFollowRepository().getStats(uid(id)))?.follower_count).toBe(2);
		expect(setStat.mock.invocationCallOrder[0]!).toBeLessThan(rank.mock.invocationCallOrder[0]!);

		await setFollowers(id, 3);
		await flush(id);
		expect(await ranked()).toEqual([id]);
		expect(await rankedAt(5)).toEqual([id]);
	});

	it('writes nothing to the ranking below the floor, and removes nothing there', async () => {
		await getKVClient().setex(FLOOR_KEY, 600, '5');
		const kept = nextId();
		const below = nextId();

		await setFollowers(kept, 7);
		await setFollowers(below, 4);
		await flush(kept);
		await flush(below);
		expect(await ranked()).toEqual([kept]);

		await setFollowers(kept, -4);
		await flush(kept);
		expect(await rankedAt(7)).toEqual([kept]);
		expect((await getFollowRepository().getStats(uid(kept)))?.follower_count).toBe(3);
	});

	it('ranks nothing while the build has written no floor, or after it deleted the floor', async () => {
		const [early, middle, late] = [nextId(), nextId(), nextId()];
		await setFollowers(early, 3);
		await flush(early);
		expect(await ranked()).toEqual([]);

		await getKVClient().setex(FLOOR_KEY, 600, '1');
		advance(10_000);
		await setFollowers(middle, 3);
		await flush(middle);
		expect(await ranked()).toEqual([middle]);

		await getKVClient().del(FLOOR_KEY);
		advance(10_000);
		await setFollowers(late, 3);
		await flush(late);
		expect(await ranked()).toEqual([middle]);
	});

	it('reads the floor once for many flushes within 10 seconds', async () => {
		await getKVClient().setex(FLOOR_KEY, 600, '1');
		const floorReads = vi.spyOn(FollowRepository.prototype, 'getFollowerRankFloor');
		const ids = Array.from({length: 7}, nextId);
		for (const id of ids) await setFollowers(id, 1);

		await Promise.all(ids.slice(0, 5).map(flush));
		expect(floorReads).toHaveBeenCalledTimes(1);
		advance(9_999);
		await flush(ids[5]!);
		expect(floorReads).toHaveBeenCalledTimes(1);
		advance(1);
		await flush(ids[6]!);
		expect(floorReads).toHaveBeenCalledTimes(2);
		expect((await ranked()).sort()).toEqual([...ids].sort());
	});

	it('keeps the counter dirty and retries both writes when the ranking write fails', async () => {
		await getKVClient().setex(FLOOR_KEY, 600, '1');
		vi.spyOn(FollowRepository.prototype, 'rankFollowers').mockRejectedValueOnce(new Error('KV write failed'));
		const id = nextId();
		const dirty = counterDirtyKey(counterPartition(FOLLOWER_COUNT_COUNTER, id));

		await setFollowers(id, 4);
		await flush(id);
		expect(await ranked()).toEqual([]);
		expect(await getKVClient().sismember(dirty, `${FOLLOWER_COUNT_COUNTER}:${id}`)).toBe(1);

		await flush(id);
		expect(await rankedAt(4)).toEqual([id]);
		expect(await getKVClient().sismember(dirty, `${FOLLOWER_COUNT_COUNTER}:${id}`)).toBe(0);
		expect((await getFollowRepository().getStats(uid(id)))?.follower_count).toBe(4);
	});

	it('lists the most followed first and trims the tail past the kept size in pages, reporting the size before', async () => {
		const repository = getFollowRepository();
		const kv = getKVClient();
		const zadd = vi.spyOn(kv, 'zadd');
		const zrem = vi.spyOn(kv, 'zrem');
		await repository.rankFollowers([]);
		await repository.unrankFollowers([]);
		expect(zadd).not.toHaveBeenCalled();
		expect(zrem).not.toHaveBeenCalled();

		// Counts 1..12 500 by ID, so the most followed has the highest ID.
		const ids = Array.from({length: 12_500}, (_, index) => createUserID(8_000_000_000n + BigInt(index)));
		await repository.rankFollowers(ids.map((id, index) => [id, index + 1]));
		expect(zadd).toHaveBeenCalledTimes(13);
		const newestFirst = [...ids].reverse();
		expect(await repository.listRankedFollowers(3)).toEqual(newestFirst.slice(0, 3));

		expect(await repository.pruneRankedFollowers(1000)).toEqual({ranked: 12_500, pruned: 11_500});
		expect(zrem).toHaveBeenCalledTimes(2);
		expect(await kv.zcard(RANK_KEY)).toBe(1000);
		expect(await repository.listRankedFollowers(2000)).toEqual(newestFirst.slice(0, 1000));

		zrem.mockClear();
		await repository.unrankFollowers(newestFirst.slice(0, 1500));
		expect(zrem).toHaveBeenCalledTimes(2);
		expect(await kv.zcard(RANK_KEY)).toBe(0);
		expect(await repository.pruneRankedFollowers(1000)).toEqual({ranked: 0, pruned: 0});
	});

	it('keeps the ranking, its floor and the backfill marks under one hash tag', async () => {
		const repository = getFollowRepository();
		const kv = getKVClient();
		const id = nextId();

		await repository.rankFollowers([[uid(id), 3]]);
		await repository.putFollowerRankFloor(3);
		expect(await repository.startFollowerRankBackfill()).toBe(true);
		expect(await kv.zrangebyscore(RANK_KEY, -3, -3)).toEqual([id]);
		expect(await kv.get(FLOOR_KEY)).toBe('3');
		expect(await kv.ttl(FLOOR_KEY)).toBe(600);
		expect(await repository.getFollowerRankFloor()).toBe(3);
		expect(await kv.get(BACKFILL_KEY)).toBe('1');
		expect(await kv.ttl(BACKFILL_KEY)).toBe(3600);

		await repository.finishFollowerRankBackfill();
		expect(await kv.get(FILLED_KEY)).toBe('1');
		expect(await kv.ttl(FILLED_KEY)).toBe(-1);
		await repository.deleteFollowerRankFloor();
		expect(await kv.get(FLOOR_KEY)).toBeNull();

		expect(new Set([RANK_KEY, FLOOR_KEY, FILLED_KEY, BACKFILL_KEY].map(computeHashSlot)).size).toBe(1);
	});

	it('starts one backfill at a time, keeps it alive, and marks the ranking filled when it finishes', async () => {
		const repository = getFollowRepository();
		expect(await repository.getFollowerRankFilled()).toBeNull();
		expect(await repository.startFollowerRankBackfill()).toBe(true);
		expect(await repository.startFollowerRankBackfill()).toBe(false);

		advance(3000_000);
		await repository.continueFollowerRankBackfill();
		advance(3000_000);
		expect(await repository.startFollowerRankBackfill()).toBe(false);

		await repository.finishFollowerRankBackfill();
		expect(await repository.getFollowerRankFilled()).toBe(0);
		expect(await getKVClient().get(BACKFILL_KEY)).toBeNull();

		// A failed backfill lets the next build start another at once; an abandoned one lapses after an hour.
		expect(await repository.startFollowerRankBackfill()).toBe(true);
		await repository.clearFollowerRankBackfill();
		expect(await repository.startFollowerRankBackfill()).toBe(true);
		advance(3_600_000);
		expect(await repository.startFollowerRankBackfill()).toBe(true);
	});

	it('drops an account from the ranking when its follower data is deleted', async () => {
		const repository = getFollowRepository();
		const [deleted, kept] = [nextId(), nextId()];
		await repository.rankFollowers([
			[uid(deleted), 5],
			[uid(kept), 4],
		]);

		await repository.deleteFollowerData(uid(deleted));
		expect(await ranked()).toEqual([kept]);
	});

	it('drops a permanently banned account from the ranking', async () => {
		const [banned, kept] = [nextId(), nextId()];
		await getFollowRepository().rankFollowers([
			[uid(banned), 5],
			[uid(kept), 4],
		]);

		await onUserBanned({userId: uid(banned)});
		expect(await ranked()).toEqual([kept]);
	});

	it('the floor survives only as a whole number of at least 1', async () => {
		const repository = getFollowRepository();
		expect(await repository.getFollowerRankFloor()).toBeNull();
		for (const raw of ['abc', '0', '-3', '2.5', '', 'Infinity']) {
			await getKVClient().setex(FLOOR_KEY, 600, raw);
			expect(await repository.getFollowerRankFloor()).toBeNull();
		}
		await getKVClient().setex(FLOOR_KEY, 600, '7');
		expect(await repository.getFollowerRankFloor()).toBe(7);
	});

	// Last: it swaps the Cassandra executor for a paged one and leaves an empty in-memory one behind.
	it('reads the stored follower counts page by page for the backfill', async () => {
		setCassandraQueryExecutorForTesting(new PagedInMemoryExecutor());
		try {
			const repository = getFollowRepository();
			const [a, b, c, noFollowers] = [nextId(), nextId(), nextId(), nextId()];
			await repository.setStat(uid(a), 'follower_count', 5);
			await repository.setStat(uid(b), 'follower_count', 7);
			await repository.setStat(uid(c), 'follower_count', 9);
			await repository.setStat(uid(noFollowers), 'following_count', 2);

			const first = await repository.scanFollowerCountsPage(null, 3);
			expect(first.rows).toHaveLength(3);
			expect(first.pageState).not.toBeNull();
			const second = await repository.scanFollowerCountsPage(first.pageState, 3);
			expect(second.pageState).toBeNull();

			const counts = new Map(
				[...first.rows, ...second.rows].map((row) => [row.user_id.toString(), row.follower_count]),
			);
			expect(counts).toEqual(
				new Map([
					[a, 5],
					[b, 7],
					[c, 9],
					[noFollowers, 0],
				]),
			);
		} finally {
			setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
		}
	});
});
