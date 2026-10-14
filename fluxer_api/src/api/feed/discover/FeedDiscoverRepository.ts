// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import type {DiscoverSnapshot} from '@app/api/feed/discover/FeedDiscoverCache';
import {TREND_WINDOW_MS, type TrendState} from '@app/api/feed/discover/FeedDiscoverRules';
import {feedDayStart} from '@app/api/feed/FeedRepository';
import {counterPartition} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

// TEMPORARY: single ranking ZSET. Trigger: zcard above 1 M in the Keşfet build log, or above 30 K zadd/s
// (new members per second from consecutive build logs: ranked minus the last build's ranked, pruned and removed, over
// the time between them; score updates of ranked posts come at most once per post per 10 s flush). Path: 16 keys by
// post_id % 16, the build merges the heads of the parts.
const RANKED_KEY = 'feed:discover:z';
const EVICTED_KEY = 'feed:discover:evicted';
export const DISCOVER_REFRESH_CHANNEL = 'feed:discover:refresh';
export const EVICTION_MEMORY_MS = 120_000;
// A snapshot's evictions stay readable from shortly before it was built: processes that read an old snapshot still get
// every removal made after it.
export const EVICTION_MARGIN_MS = 10_000;
export const DISCOVER_SNAPSHOT_KEY = 'feed:discover:snapshot';
const SNAPSHOT_TTL_SECONDS = 3600;
const BUILD_KEY = 'feed:discover:build';
const BUILD_MIN_INTERVAL_SECONDS = 20;
const RANKED_MAX = 200_000;
const PRUNE_PAGE = 10_000;
const PRUNE_MAX = 100_000;
const KEY_CHUNK = 1000;
const BLOCK_SET_TTL_SECONDS = 60;
const BLOCK_SET_FORGET_SECONDS = 5;
// TEMPORARY: counted-liker sets (per public post, for its 72 h window). A post's first 100 K counted likers are
// kept one by one; past that only 1 in 16 accounts (by a hash of the user ID) counts, 16 times, and only those are
// kept, so a viral post keeps rising (with forward decay a capped count would freeze its score) while its sets grow 16x
// slower. Trigger: the once-per-post "counted likers cap reached" log above 100 posts a day, or the liker sets above
// 10 % of Valkey memory. Path: a trend_weight column on feed_post_likes written
// with the like and read under the like lock on unlike; the sets go away.
export const TREND_MAX_COUNTED_LIKERS = 100_000;
export const TREND_LIKER_SAMPLE = 16;
const LIKER_SAMPLE_NAMESPACE = 'feed_trend_sample';
const WINDOW_SECONDS = TREND_WINDOW_MS / 1000;
const DAILY_TTL_SECONDS = 2 * 86_400;
const trendStateKey = (postId: bigint) => `feed:trend:${postId}`;
const dailyKey = (userId: UserID, day: number) => `feed:trend:daily:${userId}:${day}`;
const dailyReportsKey = (userId: UserID, day: number) => `feed:discover:reports:daily:${userId}:${day}`;
const authorDailyKey = (userId: UserID, authorId: UserID, day: number) =>
	`feed:trend:author:${userId}:${authorId}:${day}`;
const likersKey = (postId: bigint) => `feed:trend:likers:${postId}`;
const sampledLikersKey = (postId: bigint) => `feed:trend:likers:s:${postId}`;
const commentersKey = (postId: bigint) => `feed:trend:commenters:${postId}`;
const reportersKey = (postId: bigint) => `feed:discover:reports:${postId}`;
const hiddenKey = (postId: bigint) => `feed:discover:hidden:${postId}`;
const clearedKey = (postId: bigint) => `feed:discover:cleared:${postId}`;
const blockSetKey = (userId: UserID) => `feed:discover:blocks:${userId}`;

export interface DiscoverBlockSet {
	ids: Set<string>;
	overflow: boolean;
}

// Keşfet's KV state: trend states, the one ranking ZSET (score -L, since the KV client reads ascending only),
// daily contribution and report counts, counted likers, first commenters, reporters, the hidden flag and the moderator's
// restore mark, recent evictions, the list snapshot with its build gate, and readers' block sets.
export class FeedDiscoverRepository {
	constructor(private readonly kv: IKVProvider) {}

	async getTrendState(postId: bigint): Promise<TrendState | null> {
		const raw = await this.kv.get(trendStateKey(postId));
		return raw === null ? null : (JSON.parse(raw) as TrendState);
	}

	async putTrendState(postId: bigint, state: TrendState): Promise<void> {
		await this.kv.setex(trendStateKey(postId), WINDOW_SECONDS, JSON.stringify(state));
	}

	async rankPost(postId: bigint, score: number): Promise<void> {
		await this.kv.zadd(RANKED_KEY, -score, postId.toString());
	}

	async unrankPost(postId: bigint): Promise<void> {
		await this.kv.zrem(RANKED_KEY, postId.toString());
	}

	async listRanked(offset: number, limit: number): Promise<Array<bigint>> {
		return (await this.kv.zrangebyscore(RANKED_KEY, '-inf', '+inf', 'LIMIT', offset, limit)).map((id) => BigInt(id));
	}

	/**
	 * Trims the ranking's tail past 200 K by its whole excess, at most 100 K a build, 10 K a call (see RANKED_KEY).
	 * Returns the size before and how many went, for the build log: consecutive logs give the ranking's growth.
	 */
	async pruneRanked(): Promise<{ranked: number; pruned: number}> {
		const ranked = await this.kv.zcard(RANKED_KEY);
		const excess = Math.min(ranked - RANKED_MAX, PRUNE_MAX);
		let pruned = 0;
		while (pruned < excess) {
			const tail = await this.kv.zrangebyscore(
				RANKED_KEY,
				'-inf',
				'+inf',
				'LIMIT',
				RANKED_MAX,
				Math.min(PRUNE_PAGE, excess - pruned),
			);
			if (tail.length === 0) break;
			await this.kv.zrem(RANKED_KEY, ...tail);
			pruned += tail.length;
		}
		return {ranked, pruned};
	}

	async unrankPosts(postIds: Array<bigint>): Promise<void> {
		for (let start = 0; start < postIds.length; start += KEY_CHUNK) {
			await this.kv.zrem(RANKED_KEY, ...postIds.slice(start, start + KEY_CHUNK).map(String));
		}
	}

	async listHidden(postIds: Array<bigint>): Promise<Set<bigint>> {
		const hidden = new Set<bigint>();
		for (let start = 0; start < postIds.length; start += KEY_CHUNK) {
			const chunk = postIds.slice(start, start + KEY_CHUNK);
			const flags = await this.kv.mget(...chunk.map(hiddenKey));
			flags.forEach((raw, index) => {
				if (raw !== null) hidden.add(chunk[index]!);
			});
		}
		return hidden;
	}

	async getSnapshot(): Promise<DiscoverSnapshot | null> {
		const raw = await this.kv.get(DISCOVER_SNAPSHOT_KEY);
		return raw === null ? null : (JSON.parse(raw) as DiscoverSnapshot);
	}

	/** Returns the stored size in bytes, for the build log (the build keeps it within 2 MB, see FeedDiscoverCache). */
	async putSnapshot(snapshot: DiscoverSnapshot): Promise<number> {
		const raw = JSON.stringify(snapshot);
		await this.kv.setex(DISCOVER_SNAPSHOT_KEY, SNAPSHOT_TTL_SECONDS, raw);
		return Buffer.byteLength(raw);
	}

	/**
	 * One build at a time, and at most one start per 20 s across workers: cron runs that piled up behind a busy batch lane
	 * end at once. Returns the build's token, or null. The KV client has no compare-and-set for the snapshot, so a build
	 * keeps this gate while it runs (holdBuild) instead, and one that lost it writes nothing.
	 */
	async claimBuild(): Promise<string | null> {
		const token = randomUUID();
		return (await this.kv.acquireLock(BUILD_KEY, token, BUILD_MIN_INTERVAL_SECONDS)) ? token : null;
	}

	/** Keeps the build's gate `seconds` more; false once it lapsed and another build may hold it. */
	holdBuild(token: string, seconds = BUILD_MIN_INTERVAL_SECONDS): Promise<boolean> {
		return this.kv.extendLock(BUILD_KEY, token, seconds);
	}

	/** After the build: the gate lasts until 20 s after its start, so a long build does not skip the next cron run. */
	async endBuild(token: string, startedAtMs: number): Promise<void> {
		const leftMs = BUILD_MIN_INTERVAL_SECONDS * 1000 - (Date.now() - startedAtMs);
		await this.holdBuild(token, Math.max(1, Math.ceil(leftMs / 1000)));
	}

	async listEvictionsSince(since: number): Promise<Set<string>> {
		return new Set(await this.kv.zrangebyscore(EVICTED_KEY, since, '+inf'));
	}

	/** Called only after a new snapshot is stored, with its version minus the margin; walks until nothing older is left. */
	async pruneEvictionsBefore(before: number): Promise<void> {
		for (;;) {
			// The KV client takes only numbers and ±inf as bounds (no Redis '(' exclusive form). Scores and `before` are
			// whole milliseconds (Date.now()), so "below before" is "at most before - 1".
			const old = await this.kv.zrangebyscore(EVICTED_KEY, '-inf', before - 1, 'LIMIT', 0, KEY_CHUNK);
			if (old.length > 0) await this.kv.zrem(EVICTED_KEY, ...old);
			if (old.length < KEY_CHUNK) return;
		}
	}

	async countEvictions(): Promise<number> {
		return this.kv.zcard(EVICTED_KEY);
	}

	async getBlockSet(userId: UserID): Promise<DiscoverBlockSet | null> {
		const raw = await this.kv.get(blockSetKey(userId));
		if (raw === null || raw === '-') return null;
		const {ids, overflow} = JSON.parse(raw) as {ids: Array<string>; overflow: boolean};
		return {ids: new Set(ids), overflow};
	}

	/** SETNX: a set computed before a block cannot land over the block hook's marker. */
	async putBlockSet(userId: UserID, set: DiscoverBlockSet): Promise<void> {
		const raw = JSON.stringify({ids: [...set.ids], overflow: set.overflow});
		await this.kv.setnx(blockSetKey(userId), raw, BLOCK_SET_TTL_SECONDS);
	}

	/** The block hook: both accounts' sets are recomputed on their next page, and nothing older can be written for 5 s. */
	async forgetBlockSets(userIds: Array<UserID>): Promise<void> {
		for (const userId of userIds) await this.kv.setex(blockSetKey(userId), BLOCK_SET_FORGET_SECONDS, '-');
	}

	async countContribution(userId: UserID, day: number): Promise<number> {
		return this.countDaily(dailyKey(userId, day));
	}

	/** A reporter's reports counted toward hiding posts today (their own allowance, not the 300 reactions). */
	async countReport(userId: UserID, day: number): Promise<number> {
		return this.countDaily(dailyReportsKey(userId, day));
	}

	/**
	 * An account's contributions to one author's posts today; the key lives until the day ends (at
	 * least a minute, so it cannot lapse between its two writes and come back without a lifetime).
	 * TEMPORARY: one key per (account, author, day). At 10 M daily actives with ~10 authors each that is up to
	 * ~100 M short keys (~5-9 GB of Valkey) by the end of a day. Trigger: these keys above 5 % of Valkey memory. Path: one
	 * hash per account and day (HINCRBY, field = author) once the KV client has it, ~5x smaller.
	 */
	async countAuthorContribution(userId: UserID, authorId: UserID, day: number, now = Date.now()): Promise<number> {
		const leftMs = feedDayStart(day + 1).getTime() - now;
		return this.countDaily(authorDailyKey(userId, authorId, day), Math.max(60, Math.ceil(leftMs / 1000)));
	}

	/** The weight multiplier this like counts with: 1 below the cap, 16 for a sampled account past it, else 0. */
	async addLiker(postId: bigint, userId: UserID, now = Date.now()): Promise<number> {
		const size = await this.kv.scard(likersKey(postId));
		if (size < TREND_MAX_COUNTED_LIKERS) {
			if (!(await this.addToWindowSet(likersKey(postId), postId, userId, now))) return 0;
			if (size === TREND_MAX_COUNTED_LIKERS - 1) {
				Logger.info({postId: postId.toString()}, 'Keşfet counted likers cap reached; sampling 1 in 16 from here');
			}
			return 1;
		}
		if (counterPartition(LIKER_SAMPLE_NAMESPACE, userId.toString()) % TREND_LIKER_SAMPLE !== 0) return 0;
		return (await this.addToWindowSet(sampledLikersKey(postId), postId, userId, now)) ? TREND_LIKER_SAMPLE : 0;
	}

	/** The multiplier this unlike takes back: the set the like was counted in says how much (an uncounted like: 0). */
	async removeLiker(postId: bigint, userId: UserID): Promise<number> {
		if ((await this.kv.srem(likersKey(postId), userId.toString())) === 1) return 1;
		return (await this.kv.srem(sampledLikersKey(postId), userId.toString())) === 1 ? TREND_LIKER_SAMPLE : 0;
	}

	async countLikers(postId: bigint): Promise<number> {
		return this.kv.scard(likersKey(postId));
	}

	/** Whether this is the account's first comment on the post (max_comments_per_post bounds the set). */
	async addCommenter(postId: bigint, userId: UserID, now = Date.now()): Promise<boolean> {
		return this.addToWindowSet(commentersKey(postId), postId, userId, now);
	}

	async addReporter(postId: bigint, userId: UserID, now = Date.now()): Promise<number> {
		await this.addToWindowSet(reportersKey(postId), postId, userId, now);
		return this.kv.scard(reportersKey(postId));
	}

	/** Whether this call hid the post (a moderator undoes it with restorePost; it lapses after 72 hours). */
	async hidePost(postId: bigint): Promise<boolean> {
		return this.kv.setnx(hiddenKey(postId), '1', WINDOW_SECONDS);
	}

	/**
	 * A moderator's restore of a report-hidden post. The 72 h mark goes first, so a report racing the
	 * restore cannot hide the post again; then the hide and its reports go, and the post returns to the ranking with its
	 * stored score (no score, nothing to rank: it never had a counted reaction). Separate keys, no MULTI: they sit in
	 * different cluster slots.
	 */
	async restorePost(postId: bigint): Promise<void> {
		await this.kv.setex(clearedKey(postId), WINDOW_SECONDS, '1');
		await this.kv.del(hiddenKey(postId), reportersKey(postId));
		const state = await this.getTrendState(postId);
		if (state?.L != null) await this.rankPost(postId, state.L);
	}

	async isRestored(postId: bigint): Promise<boolean> {
		return (await this.kv.get(clearedKey(postId))) !== null;
	}

	/** Recorded in the evictions ZSET (processes that start or reconnect read it), then broadcast. */
	async publishEvict(kind: 'post' | 'author', id: string, now = Date.now()): Promise<void> {
		await this.kv.zadd(EVICTED_KEY, now, `${kind}:${id}`);
		await this.kv.publish(DISCOVER_REFRESH_CHANNEL, `${kind}:${id}`);
	}

	// The key is created with its lifetime (SET NX EX) before the increment: no separate EXPIRE that could be lost.
	private async countDaily(key: string, ttlSeconds = DAILY_TTL_SECONDS): Promise<number> {
		await this.kv.setnx(key, '0', ttlSeconds);
		return this.kv.incr(key);
	}

	// Adds a member and sets the lifetime in one MULTI (one key, one slot). The lifetime ends with the post's 72 h window,
	// the same moment on every call, so repeating it never extends the set, and a lost EXPIRE is set again by the next
	// add. An EXPIRE error is logged, not thrown: the member is in, and the caller must count it as added.
	private async addToWindowSet(key: string, postId: bigint, userId: UserID, now: number): Promise<boolean> {
		const remainingMs = snowflakeToDate(postId).getTime() + TREND_WINDOW_MS - now;
		const [[addError, added] = [null, 0], [expireError] = [null]] = await this.kv
			.multi()
			.sadd(key, userId.toString())
			.expire(key, Math.max(1, Math.ceil(remainingMs / 1000)))
			.exec();
		if (addError) throw addError;
		if (expireError) Logger.warn({error: expireError, key}, 'Setting a Keşfet reaction set lifetime failed');
		return added === 1;
	}
}
