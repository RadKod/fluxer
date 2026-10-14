// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import type {UserFollowStatsRow} from '@app/api/database/types/FollowTypes';
import type {FollowRepository} from '@app/api/follow/FollowRepository';
import type {CounterFlusher} from '@app/api/infrastructure/KVCounterService';

export const FOLLOWER_COUNT_COUNTER = 'user_follower_count';
export const FOLLOWING_COUNT_COUNTER = 'user_following_count';
const RECOUNT_PAGE_SIZE = 5000;
const FLOOR_READ_INTERVAL_MS = 10_000;

// KV counters with their bases in user_follow_stats. recount runs only from the RebuildCounter worker task.
// GEÇİCİ (temporary): nothing queues that task for these counters yet, so a follow whose conditional write applied but
// whose counter delta failed stays off by one until someone runs rebuildCounter {namespace, id} by hand (the drift
// only shows as a count, no access depends on it). Trigger: the first such manual rebuild that changes a value. Path:
// on follow/unfollow, setnx a one-day `follow:recount:{<user id>}` key and queue rebuildCounter for following_count
// (at most max_following rows), and for follower_count only below feed_fanout_min_followers, since a celebrity's
// recount reads every follower bucket.
export function createFollowCounterFlushers(repository: FollowRepository): Array<CounterFlusher> {
	const userId = (id: string): UserID => createUserID(BigInt(id));
	// Both bases live in one user_follow_stats row, so the two base reads of one profile view (a KV miss on both
	// counts) share one Cassandra read.
	const inflightStats = new Map<string, Promise<UserFollowStatsRow | null>>();
	const readStats = (id: string): Promise<UserFollowStatsRow | null> => {
		let pending = inflightStats.get(id);
		if (!pending) {
			pending = repository.getStats(userId(id)).finally(() => inflightStats.delete(id));
			inflightStats.set(id, pending);
		}
		return pending;
	};
	// The floor the suggestion build keeps, read at most once per 10 s per process however many counters a
	// flush settles; concurrent reads share one GET. null (the flag is off, no build for 10 min, or KV lost it): rank nothing.
	let floor: {value: number | null; readAt: number} | null = null;
	let floorRead: Promise<number | null> | null = null;
	const rankFloor = (): Promise<number | null> => {
		if (floor && Date.now() - floor.readAt < FLOOR_READ_INTERVAL_MS) return Promise.resolve(floor.value);
		floorRead ??= repository
			.getFollowerRankFloor()
			.then((value) => {
				floor = {value, readAt: Date.now()};
				return value;
			})
			.finally(() => {
				floorRead = null;
			});
		return floorRead;
	};
	return [
		{
			namespace: FOLLOWER_COUNT_COUNTER,
			async readBase(id) {
				return (await readStats(id))?.follower_count ?? 0;
			},
			async flush(id, value) {
				const count = Math.max(0, value);
				await repository.setStat(userId(id), 'follower_count', count);
				// the ranking after the base, both repeatable; a failure keeps the counter dirty
				// and the next flush writes both again (KVCounterService.flushPartition). Below the floor nothing is written
				// or removed.
				const current = await rankFloor();
				if (current !== null && count >= current) await repository.rankFollowers([[userId(id), count]]);
			},
			async recount(id) {
				let count = 0;
				let before: bigint | undefined;
				for (;;) {
					const page = await repository.listFollowers(userId(id), {before, limit: RECOUNT_PAGE_SIZE});
					if (page.length === 0) return count;
					count += page.length;
					before = page.at(-1)!.follow_id;
				}
			},
		},
		{
			namespace: FOLLOWING_COUNT_COUNTER,
			async readBase(id) {
				return (await readStats(id))?.following_count ?? 0;
			},
			async flush(id, value) {
				await repository.setStat(userId(id), 'following_count', Math.max(0, value));
			},
			async recount(id) {
				let count = 0;
				let after: UserID | undefined;
				for (;;) {
					const page = await repository.listFollowing(userId(id), {after, limit: RECOUNT_PAGE_SIZE});
					count += page.length;
					if (page.length < RECOUNT_PAGE_SIZE) return count;
					after = page.at(-1)!.target_id;
				}
			},
		},
	];
}
