// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import {
	BatchBuilder,
	deleteOneOrMany,
	fetchMany,
	fetchManyInChunks,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {FeedHomeRow, FeedPostRow} from '@app/api/database/types/FeedTypes';
import type {MessageEmbed, MessageEmbedChild} from '@app/api/database/types/MessageTypes';
import {FeedAuthorBuckets, FeedHome, FeedPosts, FeedPostsByAuthor} from '@app/api/feed/FeedTables';
import {replaceIfUnchanged} from '@app/api/user/profile/ProfileAccessCache';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {createSnowflakeFromTimestamp, FLUXER_EPOCH, TIMESTAMP_SHIFT} from '@fluxer/snowflake/src/Snowflake';
import {makeBucket} from '@fluxer/snowflake/src/SnowflakeBuckets';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import {runSlotBatches, splitIntoSlotBatches} from '@pkgs/kv_client/src/KVHashSlots';

const DAY_MS = 86_400_000;
// The feed_home TTL: the home feed, a celebrity's pulled posts and feed:last:<author_id> all cover these 30 days.
export const HOME_WINDOW_DAYS = 30;
export const NO_CURSOR = (1n << 63n) - 1n;
export const CELEBRITY_RECENT_POSTS = 20;

const BUCKET_LIST_PAGE = 32;
const HOME_WRITE_CONCURRENCY = 32;
const MGET_CHUNK = 1000;
const POST_CACHE_TTL_SECONDS = 60;
// Written over a deleted post's cache entry for one cache lifetime; fills never overwrite an entry (SET NX).
const POST_TOMBSTONE = '-';
// How long a home read trusts a profile access verdict: a follower who lost access still sees the author's posts in
// the home feed for up to this long (the post and profile routes check on every request).
const AUTHOR_ACCESS_TTL_SECONDS = 60;
const HOME_WINDOW_SECONDS = HOME_WINDOW_DAYS * 86_400;
const DAILY_COUNT_TTL_SECONDS = 2 * 86_400;
const CELEBRITIES_KEY = 'feed:celebrities';
// A popular author's profile opens on the first page of their posts; it is kept
// 15 s in KV so feed_author_buckets and the newest feed_posts_by_author partition are read once per 15 s, not per visitor.
// Writes and deletes put a 5 s drop marker of their own ('-' and a random token); a fill after a plain miss uses SETNX, so
// one that read before a write cannot land, and a fill that saw a marker began after that write and replaces that very
// marker, never a newer one (the profile access cache's rule), so a popular author is not left unkept
// for 5 s right after posting.
// TEMPORARY: one KV key per author, so a viral author's key is read by every visitor. Path: a 2 s copy per
// API process (the profile side record's pattern). Trigger: more than 50 K GET/s on one feed:author_first key.
const AUTHOR_FIRST_PAGE = 50;
const AUTHOR_FIRST_TTL_SECONDS = 15;
const AUTHOR_FIRST_DROPPED_SECONDS = 5;
const AUTHOR_FIRST_DROPPED = '-';
const CELEBRITY_PRUNE_PAGE = 1000;
const BIGINT_TAG = '$bigint';

/** The feed day of a snowflake: whole days since the Fluxer epoch (feed_home and feed_likes_by_user partitions). */
export function feedDay(snowflake: bigint): number {
	return Number((snowflake >> TIMESTAMP_SHIFT) / BigInt(DAY_MS));
}

export function feedDayAt(nowMs: number): number {
	return Math.floor((nowMs - Number(FLUXER_EPOCH)) / DAY_MS);
}

export function feedDayStart(day: number): Date {
	return new Date(Number(FLUXER_EPOCH) + day * DAY_MS);
}

/** The oldest post ID the home feed shows at `nowMs`. */
export function homeFloorId(nowMs: number): bigint {
	return createSnowflakeFromTimestamp(nowMs - HOME_WINDOW_DAYS * DAY_MS);
}

const postCacheKey = (postId: bigint) => `feed:post:${postId}`;
const lastPostKey = (authorId: UserID) => `feed:last:${authorId}`;
const dailyPostsKey = (authorId: UserID, day: number) => `feed:posts_today:${authorId}:${day}`;
const celebrityRecentKey = (authorId: UserID | string) => `feed:celebrity:recent:${authorId}`;
const authorAccessKey = (viewerId: UserID, authorId: UserID) => `feed:access:${viewerId}:${authorId}`;
const authorFirstKey = (authorId: UserID) => `feed:author_first:${authorId}`;

/**
 * A reader's verdict on an author, cached 60 s: '1' the full profile view; 'p' the public view (a standing
 * stranger of a public author), so only the author's public posts reach them; '0' anything else. A home read keeps a
 * cached '1' or 'p' only while the author's level still allows it (FeedTimelineService.checkAuthors). An older API
 * process reads only '1' as visible, so it takes 'p' as hidden.
 */
export type AuthorAccess = '1' | 'p' | '0';

function encodePost(row: FeedPostRow): string {
	return JSON.stringify(row, (_key, value) => (typeof value === 'bigint' ? {[BIGINT_TAG]: value.toString()} : value));
}

function decodeEmbedTimestamp<T extends MessageEmbedChild>(embed: T): T {
	return {...embed, timestamp: embed.timestamp ? new Date(embed.timestamp) : null};
}

function decodeEmbed(embed: MessageEmbed): MessageEmbed {
	return {...decodeEmbedTimestamp(embed), children: embed.children?.map(decodeEmbedTimestamp) ?? embed.children};
}

function decodePost(raw: string): FeedPostRow {
	const row = JSON.parse(raw, (_key, value) =>
		value !== null && typeof value === 'object' && BIGINT_TAG in value ? BigInt(value[BIGINT_TAG]) : value,
	) as FeedPostRow;
	return {
		...row,
		edited_at: row.edited_at ? new Date(row.edited_at) : null,
		poll_expires_at: row.poll_expires_at ? new Date(row.poll_expires_at) : row.poll_expires_at,
		embeds: row.embeds ? row.embeds.map(decodeEmbed) : row.embeds,
	};
}

function decodeIds(raw: string | null): Array<bigint> | null {
	return raw === null ? null : (JSON.parse(raw) as Array<string>).map((id) => BigInt(id));
}

const FETCH_POSTS_CQL = FeedPosts.selectCql({where: FeedPosts.where.in('post_id', 'post_ids')});
const FETCH_POST_AUTHOR_CQL = FeedPosts.selectCql({
	columns: ['author_id'],
	where: FeedPosts.where.eq('post_id'),
	limit: 1,
});
const FETCH_AUTHOR_BUCKETS_CQL = FeedAuthorBuckets.selectCql({
	columns: ['bucket'],
	where: [FeedAuthorBuckets.where.eq('author_id'), FeedAuthorBuckets.where.lte('bucket', 'from_bucket')],
	orderBy: {col: 'bucket', direction: 'DESC'},
	limit: BUCKET_LIST_PAGE,
});

function authorPostsQuery(limit: number) {
	return FeedPostsByAuthor.select({
		columns: ['post_id'],
		where: [
			FeedPostsByAuthor.where.eq('author_id'),
			FeedPostsByAuthor.where.eq('bucket'),
			FeedPostsByAuthor.where.lt('post_id', 'before'),
		],
		orderBy: {col: 'post_id', direction: 'DESC'},
		limit,
	});
}

function homeQuery(limit: number) {
	return FeedHome.select({
		where: [FeedHome.where.eq('user_id'), FeedHome.where.eq('day'), FeedHome.where.lt('post_id', 'before')],
		orderBy: {col: 'post_id', direction: 'DESC'},
		limit,
	});
}

// feed_posts, feed_posts_by_author, feed_author_buckets and feed_home, plus the feed's KV state: the 60 s post cache,
// feed:last:<author_id>, the daily post count and the celebrity index that FeedTimelineService polls.
export class FeedRepository {
	constructor(private readonly kv: IKVProvider) {}

	/** Post row, author index row and bucket list entry in one logged batch. */
	async createPost(row: FeedPostRow): Promise<void> {
		const bucket = makeBucket(row.post_id);
		const batch = new BatchBuilder();
		batch.addPrepared(FeedPosts.upsertAll(row));
		batch.addPrepared(FeedPostsByAuthor.upsertAll({author_id: row.author_id, bucket, post_id: row.post_id}));
		batch.addPrepared(FeedAuthorBuckets.upsertAll({author_id: row.author_id, bucket, updated_at: new Date()}));
		await batch.execute();
		await this.dropAuthorFirstPage(row.author_id);
	}

	async getPost(postId: bigint): Promise<FeedPostRow | null> {
		return (await this.getPosts([postId])).get(postId) ?? null;
	}

	/**
	 * Posts by ID through a 60 s KV cache, so a celebrity post read by every follower costs Cassandra about one read a
	 * minute. A row without author_id (a counter flush that landed after the delete) counts as missing. A fill never
	 * replaces an entry, so a read that got the row before a delete cannot put it back over the delete's tombstone.
	 */
	async getPosts(postIds: Array<bigint>): Promise<Map<bigint, FeedPostRow>> {
		const rows = new Map<bigint, FeedPostRow>();
		if (postIds.length === 0) return rows;
		const cached = await this.kv.mget(...postIds.map(postCacheKey));
		const missing = postIds.filter((postId, index) => {
			const raw = cached[index];
			if (raw === POST_TOMBSTONE) return false;
			if (raw) rows.set(postId, decodePost(raw));
			return !raw;
		});
		if (missing.length === 0) return rows;
		const fetched = (
			await fetchManyInChunks<FeedPostRow, bigint>(FETCH_POSTS_CQL, missing, (chunk) => ({post_ids: chunk}))
		).filter((row) => row.author_id != null);
		for (const row of fetched) rows.set(row.post_id, row);
		await Promise.all(
			fetched.map((row) => this.kv.setnx(postCacheKey(row.post_id), encodePost(row), POST_CACHE_TTL_SECONDS)),
		);
		return rows;
	}

	/**
	 * Writes a post's link preview, false when the post is gone. The row is checked in Cassandra, not the cache,
	 * so a deleted post gets no author-less row; the cache entry is then dropped, never overwritten, and a delete's
	 * tombstone stays, so the post cannot come back. The KV client has no compare-and-delete: GETDEL takes the entry in
	 * one step and a tombstone it took is written back at once, which leaves only that gap for a fill
	 * that read the row before the delete, and the write-back then covers it.
	 */
	async setPostEmbeds(postId: bigint, embeds: Array<MessageEmbed>): Promise<boolean> {
		const row = await fetchOne<Pick<FeedPostRow, 'author_id'>>(FETCH_POST_AUTHOR_CQL, {post_id: postId});
		if (row?.author_id == null) return false;
		await upsertOne(FeedPosts.patchByPk({post_id: postId}, {embeds: Db.set(embeds)}));
		if ((await this.kv.getdel(postCacheKey(postId))) === POST_TOMBSTONE) {
			await this.kv.setex(postCacheKey(postId), POST_CACHE_TTL_SECONDS, POST_TOMBSTONE);
		}
		return true;
	}

	/** Cached profile access verdicts of `viewerId` for each author (null when not cached). */
	async getAuthorAccess(viewerId: UserID, authorIds: Array<UserID>): Promise<Array<AuthorAccess | null>> {
		if (authorIds.length === 0) return [];
		const cached = await this.kv.mget(...authorIds.map((authorId) => authorAccessKey(viewerId, authorId)));
		return cached.map((raw) => (raw === null ? null : raw === '1' || raw === 'p' ? raw : '0'));
	}

	async putAuthorAccess(viewerId: UserID, verdicts: Array<[authorId: UserID, access: AuthorAccess]>): Promise<void> {
		const batches = splitIntoSlotBatches(
			verdicts,
			([authorId]) => authorAccessKey(viewerId, authorId),
			this.kv.isClustered(),
		);
		await runSlotBatches(batches, async (batch) => {
			const pipeline = this.kv.pipeline();
			for (const [authorId, access] of batch) {
				pipeline.setex(authorAccessKey(viewerId, authorId), AUTHOR_ACCESS_TTL_SECONDS, access);
			}
			await pipeline.exec();
		});
	}

	/**
	 * Drops both accounts' verdicts on each other (the block hook): the next home page judges them again. One key at a
	 * time, as the two may sit on different cluster slots.
	 * TEMPORARY: a home request that read the access before the block and writes its verdict after this delete keeps the
	 * old one for up to 60 s; follow removal still hides the author then. A delete marker if that ever shows up.
	 */
	async forgetAuthorAccess(userId: UserID, otherId: UserID): Promise<void> {
		await this.kv.del(authorAccessKey(userId, otherId));
		await this.kv.del(authorAccessKey(otherId, userId));
	}

	/** Post row and author index row; home feed rows stay and are filtered on read (feed_home takes no deletes). */
	async deletePost(post: Pick<FeedPostRow, 'post_id' | 'author_id'>): Promise<void> {
		const batch = new BatchBuilder();
		batch.addPrepared(FeedPosts.deleteByPk({post_id: post.post_id}));
		batch.addPrepared(
			FeedPostsByAuthor.deleteByPk({
				author_id: post.author_id,
				bucket: makeBucket(post.post_id),
				post_id: post.post_id,
			}),
		);
		await batch.execute();
		await this.kv.setex(postCacheKey(post.post_id), POST_CACHE_TTL_SECONDS, POST_TOMBSTONE);
		await this.dropAuthorFirstPage(post.author_id);
	}

	private async dropAuthorFirstPage(authorId: UserID): Promise<void> {
		await this.kv.setex(
			authorFirstKey(authorId),
			AUTHOR_FIRST_DROPPED_SECONDS,
			`${AUTHOR_FIRST_DROPPED}${randomUUID()}`,
		);
	}

	/** An author index row whose post row is already gone. */
	async deleteAuthorIndexRow(authorId: UserID, postId: bigint): Promise<void> {
		await deleteOneOrMany(
			FeedPostsByAuthor.deleteByPk({author_id: authorId, bucket: makeBucket(postId), post_id: postId}),
		);
	}

	/**
	 * One page of an author's post IDs, newest first, walking the ten day buckets back from `before`. A page is short
	 * only when the author has no older posts. A bucket older than the current one that turns out empty leaves the list.
	 * The first page (no `before`, up to 50) comes from the 15 s KV copy.
	 */
	async listAuthorPostIds(authorId: UserID, options: {before?: bigint; limit: number}): Promise<Array<bigint>> {
		if (options.before !== undefined || options.limit > AUTHOR_FIRST_PAGE) {
			return this.readAuthorPostIds(authorId, options);
		}
		const key = authorFirstKey(authorId);
		const cached = await this.kv.get(key);
		const dropped = cached?.startsWith(AUTHOR_FIRST_DROPPED) === true;
		if (cached !== null && !dropped) return decodeIds(cached)!.slice(0, options.limit);
		const ids = await this.readAuthorPostIds(authorId, {limit: AUTHOR_FIRST_PAGE});
		const encoded = JSON.stringify(ids.map(String));
		if (dropped) await replaceIfUnchanged(this.kv, key, cached!, encoded, AUTHOR_FIRST_TTL_SECONDS);
		else await this.kv.setnx(key, encoded, AUTHOR_FIRST_TTL_SECONDS);
		return ids.slice(0, options.limit);
	}

	private async readAuthorPostIds(authorId: UserID, options: {before?: bigint; limit: number}): Promise<Array<bigint>> {
		const {limit} = options;
		const ids: Array<bigint> = [];
		const currentBucket = makeBucket(null);
		let before = options.before ?? NO_CURSOR;
		let fromBucket = options.before === undefined ? currentBucket : makeBucket(options.before);
		for (;;) {
			const buckets = await fetchMany<{bucket: number}>(FETCH_AUTHOR_BUCKETS_CQL, {
				author_id: authorId,
				from_bucket: fromBucket,
			});
			for (const {bucket} of buckets) {
				const page = await fetchMany<{post_id: bigint}>(
					authorPostsQuery(limit - ids.length).bind({author_id: authorId, bucket, before}),
				);
				ids.push(...page.map((row) => row.post_id));
				if (page.length === 0 && before === NO_CURSOR && bucket < currentBucket) {
					await deleteOneOrMany(FeedAuthorBuckets.deleteByPk({author_id: authorId, bucket}));
				}
				if (ids.length >= limit) return ids;
				before = NO_CURSOR;
			}
			if (buckets.length < BUCKET_LIST_PAGE) return ids;
			fromBucket = buckets.at(-1)!.bucket - 1;
		}
	}

	/** Account deletion, once every post is gone: the bucket list and the author's KV state. */
	async deleteAuthorData(authorId: UserID): Promise<void> {
		await deleteOneOrMany(FeedAuthorBuckets.deletePartition({author_id: authorId}));
		await this.kv.del(lastPostKey(authorId));
		await this.removeCelebrity(authorId);
	}

	/** One fan-out page: a feed_home row per follower in the post's day partition (30 day TTL from the table). */
	async addToHomes(userIds: Array<UserID>, postId: bigint, authorId: UserID): Promise<void> {
		const day = feedDay(postId);
		await mapWithConcurrency(userIds, HOME_WRITE_CONCURRENCY, (userId) =>
			upsertOne(FeedHome.upsertAll({user_id: userId, day, post_id: postId, author_id: authorId})),
		);
	}

	async listHome(userId: UserID, day: number, before = NO_CURSOR, limit: number): Promise<Array<FeedHomeRow>> {
		return fetchMany<FeedHomeRow>(homeQuery(limit).bind({user_id: userId, day, before}));
	}

	async setLastPost(authorId: UserID, postId: bigint): Promise<void> {
		await this.kv.setex(lastPostKey(authorId), HOME_WINDOW_SECONDS, postId.toString());
	}

	/** The author's latest post ID within the home window, or null. */
	async getLastPost(authorId: UserID): Promise<bigint | null> {
		const raw = await this.kv.get(lastPostKey(authorId));
		return raw === null ? null : BigInt(raw);
	}

	async countPostsToday(authorId: UserID, day: number): Promise<number> {
		return Number((await this.kv.get(dailyPostsKey(authorId, day))) ?? 0);
	}

	/** Counts one more post for the day and returns the new count. */
	async addPostToday(authorId: UserID, day: number): Promise<number> {
		const key = dailyPostsKey(authorId, day);
		const count = await this.kv.incr(key);
		if (count === 1) await this.kv.expire(key, DAILY_COUNT_TTL_SECONDS);
		return count;
	}

	/** A pulled (celebrity) author's newest post IDs, or null when the author's posts are written to home feeds. */
	async getCelebrityRecent(authorId: UserID): Promise<Array<bigint> | null> {
		return decodeIds(await this.kv.get(celebrityRecentKey(authorId)));
	}

	async getCelebrityRecentMany(authorIds: Array<string>): Promise<Array<Array<bigint> | null>> {
		const lists: Array<Array<bigint> | null> = [];
		for (let start = 0; start < authorIds.length; start += MGET_CHUNK) {
			const chunk = authorIds.slice(start, start + MGET_CHUNK);
			lists.push(...(await this.kv.mget(...chunk.map(celebrityRecentKey))).map(decodeIds));
		}
		return lists;
	}

	/**
	 * Puts a post at the head of a pulled author's newest-20 list and marks the author changed, so every API process
	 * picks the list up on its next poll. The list key is also the author's pulled state (hysteresis); it expires with
	 * the home window after the author's last post.
	 * TEMPORARY: read-modify-write without a lock; two posts of one author in the same instant can drop one of them from
	 * home feeds (it stays on the profile). Move it into a Lua script if that ever shows up.
	 */
	async addCelebrityPost(authorId: UserID, postId: bigint, current?: Array<bigint> | null): Promise<void> {
		const recent = current === undefined ? await this.getCelebrityRecent(authorId) : current;
		const next = [postId, ...(recent ?? []).filter((id) => id !== postId)].slice(0, CELEBRITY_RECENT_POSTS);
		await this.kv.setex(celebrityRecentKey(authorId), HOME_WINDOW_SECONDS, JSON.stringify(next.map(String)));
		await this.kv.zadd(CELEBRITIES_KEY, Date.now(), authorId.toString());
	}

	/** Stops pulling an author; API processes drop the list on their next poll. */
	async removeCelebrity(authorId: UserID): Promise<void> {
		if ((await this.kv.del(celebrityRecentKey(authorId))) > 0) {
			await this.kv.zadd(CELEBRITIES_KEY, Date.now(), authorId.toString());
		}
	}

	/**
	 * Drops authors whose list last changed before `beforeMs` from the change index, a page per call (Fluxer's
	 * range-then-remove pattern, as the DM spam window).
	 * TEMPORARY: an author whose list changes between the two commands is dropped with the stale ones; pollers then miss
	 * that one change until the author's next post. A Lua ZREMRANGEBYSCORE on the KV client closes it if that shows up.
	 */
	async pruneCelebrities(beforeMs: number): Promise<void> {
		const stale = await this.kv.zrangebyscore(CELEBRITIES_KEY, '-inf', beforeMs, 'LIMIT', 0, CELEBRITY_PRUNE_PAGE);
		if (stale.length > 0) await this.kv.zrem(CELEBRITIES_KEY, ...stale);
	}

	/** Pulled authors whose list changed at or after `sinceMs`, including ended ones (their list is gone). */
	async listCelebritiesChangedSince(sinceMs: number): Promise<Array<string>> {
		return this.kv.zrangebyscore(CELEBRITIES_KEY, sinceMs, '+inf');
	}
}
