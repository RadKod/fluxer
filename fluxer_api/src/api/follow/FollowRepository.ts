// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchOne,
	fetchPage,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {UserFollowerRow, UserFollowingRow, UserFollowStatsRow} from '@app/api/database/types/FollowTypes';
import {UserFollowerBuckets, UserFollowers, UserFollowing, UserFollowStats} from '@app/api/follow/FollowTables';
import {onUserPairChanged} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {FLUXER_EPOCH, TIMESTAMP_SHIFT} from '@fluxer/snowflake/src/Snowflake';
import {BACKGROUND_READ_TIMEOUT_MS} from '@pkgs/cassandra/src/Client';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

// GEÇİCİ (temporary): one follower bucket per day of the follow ID. A celebrity's current bucket is the hottest
// partition of the feature (about 30 MB for 10^6 follows a day). Trigger: a daily bucket passes 10^6 rows. Path: from a
// fixed switch time new follow IDs get hour buckets (hours since the epoch, always above every day number, so the DESC
// bucket list stays newest first); followerBucket keeps the day rule for older IDs and no read changes.
const FOLLOWER_BUCKET_MS = 86_400_000n;
const BUCKET_LIST_PAGE = 32;
const MAX_BUCKET = 2_147_483_647;
const NO_CURSOR = (1n << 63n) - 1n;
// A page may stop short after this many non-empty buckets (the client reads on until an empty page), but never on
// empty ones: an empty page ends the list.
const MAX_FILLED_BUCKETS_PER_PAGE = 16;
const FOLLOWING_IDS_PAGE = 1000;
const FOLLOWING_IDS_CACHE_TTL_SECONDS = 60;
// One bucket length and never longer: listFollowers drops an empty bucket row from the day after next, and a flag that
// outlived that could hide a late follower row in the bucket. A shorter life only costs one more idempotent write.
const FOLLOWER_BUCKET_FLAG_TTL_SECONDS = Number(FOLLOWER_BUCKET_MS / 1000n);
// accounts by follower count for the feed suggestions, score -count (the KV client
// reads ascending only). The counter flush writes an account only at or above the floor the suggestion build keeps
// (the lowest kept count while it keeps at least 90 % of 1000, else the admin floor; none before the ranking is
// filled), so the set stays near 1000 plus churn. The four ranking keys share one hash tag, so a cluster keeps or loses
// them together (a lost ranking takes its filled mark with it and the build queues the backfill again).
// TEMPORARY: one ZSET key. Trigger: `ranked` above 1 M in the suggestion build log, or above 30 K new members/s
// between two builds. Path: 16 parts under their own hash tags, the build merges their heads (FeedDiscoverRepository
// RANKED_KEY).
const FOLLOWER_RANK_KEY = 'follow:rank:{rank}:followers';
const FOLLOWER_RANK_FLOOR_KEY = 'follow:rank:{rank}:floor';
const FOLLOWER_RANK_FILLED_KEY = 'follow:rank:{rank}:filled';
const FOLLOWER_RANK_BACKFILL_KEY = 'follow:rank:{rank}:backfill';
export const FOLLOWER_RANK_SIZE = 1000;
const FOLLOWER_RANK_FLOOR_TTL_SECONDS = 600;
const RANK_BACKFILL_TTL_SECONDS = 3600;
const RANK_PRUNE_PAGE = 10_000;
const RANK_PRUNE_MAX = 200_000;
const RANK_CHUNK = 1000;

export function followerBucket(followId: bigint): number {
	return Number((followId >> TIMESTAMP_SHIFT) / FOLLOWER_BUCKET_MS);
}

function followingIdsKey(userId: UserID): string {
	return `follow:following:${userId}`;
}

function followingSetKey(userId: UserID): string {
	return `follow:set:${userId}`;
}

function followerBucketFlagKey(targetId: UserID, bucket: number): string {
	return `follow:bucket:${targetId}:${bucket}`;
}

const FETCH_FOLLOW_CQL = UserFollowing.selectCql({
	where: [UserFollowing.where.eq('user_id'), UserFollowing.where.eq('target_id')],
	limit: 1,
});
// one clustering IN inside the follower's own partition (a Keşfet page's authors, at most 50).
const FETCH_FOLLOWED_AMONG_CQL = UserFollowing.selectCql({
	columns: ['target_id'],
	where: [UserFollowing.where.eq('user_id'), UserFollowing.where.in('target_id', 'target_ids')],
});
const FETCH_STATS_CQL = UserFollowStats.selectCql({where: UserFollowStats.where.eq('user_id'), limit: 1});
const FETCH_STATS_SCAN_CQL = UserFollowStats.selectCql({columns: ['user_id', 'follower_count']});
const FETCH_BUCKETS_CQL = UserFollowerBuckets.selectCql({
	columns: ['bucket'],
	where: [UserFollowerBuckets.where.eq('target_id'), UserFollowerBuckets.where.lte('bucket', 'from_bucket')],
	orderBy: {col: 'bucket', direction: 'DESC'},
	limit: BUCKET_LIST_PAGE,
});

function followingPageQuery(limit: number) {
	return UserFollowing.select({
		where: [UserFollowing.where.eq('user_id'), UserFollowing.where.gt('target_id', 'after')],
		limit,
	});
}

function followersPageQuery(limit: number) {
	return UserFollowers.select({
		where: [
			UserFollowers.where.eq('target_id'),
			UserFollowers.where.eq('bucket'),
			UserFollowers.where.lt('follow_id', 'before'),
		],
		orderBy: {col: 'follow_id', direction: 'DESC'},
		limit,
	});
}

export class FollowRepository {
	constructor(private readonly kv: IKVProvider) {}

	async getFollow(userId: UserID, targetId: UserID): Promise<UserFollowingRow | null> {
		return fetchOne<UserFollowingRow>(FETCH_FOLLOW_CQL, {user_id: userId, target_id: targetId});
	}

	/** Whether this call created the follow (LWT on the follower's own partition, never a hot one). */
	async insertFollowing(row: UserFollowingRow): Promise<boolean> {
		const applied = await executeConditional(UserFollowing.insertIfNotExists(row));
		if (applied) await this.forgetFollowing(row.user_id, row.target_id);
		return applied;
	}

	/** Whether this call removed the follow, so racing removals of one follow count once. */
	async deleteFollowing(userId: UserID, targetId: UserID, followId: bigint): Promise<boolean> {
		const applied = await executeConditional(
			UserFollowing.conditionalDeleteByPk({user_id: userId, target_id: targetId}, {follow_id: followId}),
		);
		if (applied) await this.forgetFollowing(userId, targetId);
		return applied;
	}

	// Two keys, each deleted alone: they may sit on different cluster slots. A follow is a profile bond (a mutual follow).
	private async forgetFollowing(userId: UserID, targetId: UserID): Promise<void> {
		await Promise.all([this.kv.del(followingIdsKey(userId)), this.kv.del(followingSetKey(userId))]);
		await onUserPairChanged({userId, targetId});
	}

	async putFollower(targetId: UserID, followId: bigint, userId: UserID): Promise<void> {
		const bucket = followerBucket(followId);
		await Promise.all([
			upsertOne(UserFollowers.upsertAll({target_id: targetId, bucket, follow_id: followId, user_id: userId})),
			this.putFollowerBucket(targetId, bucket),
		]);
	}

	// Once per bucket, not on every follow: a celebrity's bucket list row would otherwise take every follow of the day.
	// The flag goes in after the write, so a failed write is retried by the next follow.
	private async putFollowerBucket(targetId: UserID, bucket: number): Promise<void> {
		const flagKey = followerBucketFlagKey(targetId, bucket);
		if ((await this.kv.get(flagKey)) !== null) return;
		await upsertOne(UserFollowerBuckets.upsertAll({target_id: targetId, bucket, updated_at: new Date()}));
		await this.kv.setex(flagKey, FOLLOWER_BUCKET_FLAG_TTL_SECONDS, '1');
	}

	async deleteFollower(targetId: UserID, followId: bigint): Promise<void> {
		await deleteOneOrMany(
			UserFollowers.deleteByPk({target_id: targetId, bucket: followerBucket(followId), follow_id: followId}),
		);
	}

	/**
	 * One page of a user's followers, newest follow first, walking the day buckets back from `before` (a follow ID).
	 * A short page is not the end of the list, an empty page is. The feed fan-out reads pages of 500.
	 */
	async listFollowers(targetId: UserID, options: {before?: bigint; limit: number}): Promise<Array<UserFollowerRow>> {
		const {limit} = options;
		const rows: Array<UserFollowerRow> = [];
		let before = options.before ?? NO_CURSOR;
		let fromBucket = options.before === undefined ? MAX_BUCKET : followerBucket(options.before);
		// Only a bucket older than yesterday is dropped when empty; a newer one may be receiving its first row.
		const settledBucket = Number((BigInt(Date.now()) - FLUXER_EPOCH) / FOLLOWER_BUCKET_MS) - 1;
		let filledBuckets = 0;
		for (;;) {
			const buckets = await fetchMany<{bucket: number}>(FETCH_BUCKETS_CQL, {
				target_id: targetId,
				from_bucket: fromBucket,
			});
			for (const {bucket} of buckets) {
				const page = await fetchMany<UserFollowerRow>(
					followersPageQuery(limit).bind({target_id: targetId, bucket, before}),
				);
				if (page.length > 0) {
					rows.push(...page.slice(0, limit - rows.length));
					filledBuckets++;
				} else if (before === NO_CURSOR && bucket < settledBucket) {
					await deleteOneOrMany(UserFollowerBuckets.deleteByPk({target_id: targetId, bucket}));
				}
				if (rows.length >= limit || filledBuckets >= MAX_FILLED_BUCKETS_PER_PAGE) return rows;
				before = NO_CURSOR;
			}
			if (buckets.length < BUCKET_LIST_PAGE) return rows;
			fromBucket = buckets.at(-1)!.bucket - 1;
		}
	}

	/** One page of the accounts a user follows, by ascending user ID after `after`. */
	async listFollowing(userId: UserID, options: {after?: UserID; limit: number}): Promise<Array<UserFollowingRow>> {
		return fetchMany<UserFollowingRow>(
			followingPageQuery(options.limit).bind({user_id: userId, after: options.after ?? createUserID(0n)}),
		);
	}

	/**
	 * Every ID a user follows (at most max_following), cached in KV for 60 s; the user's own follow changes drop the
	 * cache. For the home timeline (celebrity set ∩ following list).
	 */
	async getFollowingIds(userId: UserID): Promise<Array<UserID>> {
		const cached = await this.kv.get(followingIdsKey(userId));
		if (cached !== null) {
			return (JSON.parse(cached) as Array<string>).map((id) => createUserID(BigInt(id)));
		}
		const ids: Array<UserID> = [];
		let after: UserID | undefined;
		for (;;) {
			const page = await this.listFollowing(userId, {after, limit: FOLLOWING_IDS_PAGE});
			ids.push(...page.map((row) => row.target_id));
			if (page.length < FOLLOWING_IDS_PAGE) break;
			after = page.at(-1)!.target_id;
		}
		await this.kv.setex(followingIdsKey(userId), FOLLOWING_IDS_CACHE_TTL_SECONDS, JSON.stringify(ids.map(String)));
		return ids;
	}

	/**
	 * whether `userId` follows `targetId`, from a 60 s KV set of the accounts `userId` follows (at most
	 * max_following), so a profile check of a popular account never reads that account's user_following partition. '0'
	 * keeps an empty set alive. The user's own follow changes drop it with the following-ID list.
	 * TEMPORARY: one KV key per account: a popular account's set takes a SISMEMBER from every follower whose
	 * bond is recomputed (profile, home author verdict, post routes; levels everyone and close, no shared community), all
	 * on one shard, and when it lapses every request that finds it gone rebuilds it at once (from follow:following, or
	 * from the user_following partition when that list lapsed with it: both are written together). A random spread on the
	 * TTL was left out: it only moves which lapse reads Cassandra. Trigger: more than 50 K SISMEMBER/s on one follow:set
	 * key, or rebuild reads piling on one user_following partition. Path: a 2 s per-process copy of the set (the
	 * ProfileAccessCache LocalCopies pattern; at most max_following IDs), or a SETNX rebuild lock, or carrying the answer
	 * in the pair record. Known: a rebuild that read before an unfollow and writes after its DEL keeps the set stale up
	 * to 60 s, as follow:following.
	 */
	async isFollowingCached(userId: UserID, targetId: UserID): Promise<boolean> {
		const key = followingSetKey(userId);
		if ((await this.kv.sismember(key, targetId.toString())) === 1) return true;
		if ((await this.kv.exists(key)) === 1) return false;
		const ids = await this.getFollowingIds(userId);
		const pipeline = this.kv.pipeline();
		pipeline.sadd(key, '0', ...ids.map(String));
		pipeline.expire(key, FOLLOWING_IDS_CACHE_TTL_SECONDS);
		await pipeline.exec();
		return ids.includes(targetId);
	}

	/** Which of `targetIds` (one Discover page's authors, at most 50) `userId` follows: one read of their own partition. */
	async getFollowedAmong(userId: UserID, targetIds: Array<UserID>): Promise<Set<UserID>> {
		if (targetIds.length === 0) return new Set();
		const rows = await fetchMany<{target_id: UserID}>(FETCH_FOLLOWED_AMONG_CQL, {
			user_id: userId,
			target_ids: targetIds,
		});
		return new Set(rows.map((row) => row.target_id));
	}

	async getStats(userId: UserID): Promise<UserFollowStatsRow | null> {
		return fetchOne<UserFollowStatsRow>(FETCH_STATS_CQL, {user_id: userId});
	}

	async setStat(userId: UserID, column: 'follower_count' | 'following_count', value: number): Promise<void> {
		await upsertOne(UserFollowStats.patchByPk({user_id: userId}, {[column]: Db.set(value)}));
	}

	/** Drops a deleted account's follower partitions, bucket list and stats (one partition tombstone each). */
	async deleteFollowerData(targetId: UserID): Promise<void> {
		let fromBucket = MAX_BUCKET;
		for (;;) {
			const buckets = await fetchMany<{bucket: number}>(FETCH_BUCKETS_CQL, {
				target_id: targetId,
				from_bucket: fromBucket,
			});
			for (const {bucket} of buckets) {
				await deleteOneOrMany(UserFollowers.deletePartition({target_id: targetId, bucket}));
			}
			if (buckets.length < BUCKET_LIST_PAGE) break;
			fromBucket = buckets.at(-1)!.bucket - 1;
		}
		await deleteOneOrMany(UserFollowerBuckets.deletePartition({target_id: targetId}));
		await deleteOneOrMany(UserFollowStats.deleteByPk({user_id: targetId}));
		await this.unrankFollowers([targetId]);
	}

	async rankFollowers(entries: Array<[userId: UserID, followers: number]>): Promise<void> {
		for (let start = 0; start < entries.length; start += RANK_CHUNK) {
			const chunk = entries.slice(start, start + RANK_CHUNK);
			await this.kv.zadd(FOLLOWER_RANK_KEY, ...chunk.flatMap(([id, count]) => [-Math.max(0, count), id.toString()]));
		}
	}

	async unrankFollowers(userIds: Array<UserID>): Promise<void> {
		for (let start = 0; start < userIds.length; start += RANK_CHUNK) {
			await this.kv.zrem(FOLLOWER_RANK_KEY, ...userIds.slice(start, start + RANK_CHUNK).map(String));
		}
	}

	/** The ranked accounts, most followers first by their stored score. */
	async listRankedFollowers(limit: number): Promise<Array<UserID>> {
		const ids = await this.kv.zrangebyscore(FOLLOWER_RANK_KEY, '-inf', '+inf', 'LIMIT', 0, limit);
		return ids.map((id) => createUserID(BigInt(id)));
	}

	/**
	 * Trims the ranking's tail past `keep` by its whole excess, at most 200 K a build, 10 K a call (see
	 * FOLLOWER_RANK_KEY). Returns the size before and how many went, for the suggestion build log.
	 */
	async pruneRankedFollowers(keep: number): Promise<{ranked: number; pruned: number}> {
		const ranked = await this.kv.zcard(FOLLOWER_RANK_KEY);
		const excess = Math.min(ranked - keep, RANK_PRUNE_MAX);
		let pruned = 0;
		while (pruned < excess) {
			const tail = await this.kv.zrangebyscore(
				FOLLOWER_RANK_KEY,
				'-inf',
				'+inf',
				'LIMIT',
				keep,
				Math.min(RANK_PRUNE_PAGE, excess - pruned),
			);
			if (tail.length === 0) break;
			await this.kv.zrem(FOLLOWER_RANK_KEY, ...tail);
			pruned += tail.length;
		}
		return {ranked, pruned};
	}

	/** The floor the flush ranks from, or null (none written, or not a whole number of at least 1). */
	async getFollowerRankFloor(): Promise<number | null> {
		const raw = await this.kv.get(FOLLOWER_RANK_FLOOR_KEY);
		const value = raw === null ? Number.NaN : Number(raw);
		return Number.isSafeInteger(value) && value >= 1 ? value : null;
	}

	async putFollowerRankFloor(floor: number): Promise<void> {
		await this.kv.setex(FOLLOWER_RANK_FLOOR_KEY, FOLLOWER_RANK_FLOOR_TTL_SECONDS, String(floor));
	}

	/** feature_feed_suggestions off: the flush stops ranking within 10 s and the set stays as it is. */
	async deleteFollowerRankFloor(): Promise<void> {
		await this.kv.del(FOLLOWER_RANK_FLOOR_KEY);
	}

	/** How many accounts the ranking held when its backfill finished (0: nobody reached the floor), or null before that. */
	async getFollowerRankFilled(): Promise<number | null> {
		const raw = await this.kv.get(FOLLOWER_RANK_FILLED_KEY);
		return raw === null ? null : Math.max(0, Number(raw) || 0);
	}

	/** Whether this call started the backfill; one runs at a time, and an abandoned one lapses after an hour. */
	async startFollowerRankBackfill(): Promise<boolean> {
		return this.kv.setnx(FOLLOWER_RANK_BACKFILL_KEY, '1', RANK_BACKFILL_TTL_SECONDS);
	}

	async continueFollowerRankBackfill(): Promise<void> {
		await this.kv.setex(FOLLOWER_RANK_BACKFILL_KEY, RANK_BACKFILL_TTL_SECONDS, '1');
	}

	/**
	 * Filled first, with no lifetime: a crash between the two writes leaves a finished ranking, not a second backfill. The
	 * mark keeps the ranking's size then, so the build tells a lost ranking from one that was empty from the start.
	 */
	async finishFollowerRankBackfill(): Promise<void> {
		await this.kv.set(FOLLOWER_RANK_FILLED_KEY, String(await this.kv.zcard(FOLLOWER_RANK_KEY)));
		await this.kv.del(FOLLOWER_RANK_BACKFILL_KEY);
	}

	async clearFollowerRankBackfill(): Promise<void> {
		await this.kv.del(FOLLOWER_RANK_BACKFILL_KEY);
	}

	/** The ranking went missing alone: the next backfill fills it again. */
	async clearFollowerRankFilled(): Promise<void> {
		await this.kv.del(FOLLOWER_RANK_FILLED_KEY);
	}

	/** One page of every account's stored follower count, for the ranking backfill (a background full scan). */
	async scanFollowerCountsPage(
		pageState: string | null,
		pageSize: number,
	): Promise<{rows: Array<{user_id: UserID; follower_count: number}>; pageState: string | null}> {
		const result = await fetchPage<Pick<UserFollowStatsRow, 'user_id' | 'follower_count'>>(
			FETCH_STATS_SCAN_CQL,
			{},
			{pageSize, pageState, readTimeout: BACKGROUND_READ_TIMEOUT_MS},
		);
		return {
			rows: result.rows.map((row) => ({user_id: row.user_id, follower_count: row.follower_count ?? 0})),
			pageState: result.pageState,
		};
	}
}
