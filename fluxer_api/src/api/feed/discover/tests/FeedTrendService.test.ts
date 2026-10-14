// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import {FeedPostFlags, type FeedPostRow} from '@app/api/database/types/FeedTypes';
import {TREND_LIKER_SAMPLE, TREND_MAX_COUNTED_LIKERS} from '@app/api/feed/discover/FeedDiscoverRepository';
import type {TrendAccount} from '@app/api/feed/discover/FeedDiscoverRules';
import {createFeedTrendCounterFlusher, FEED_TREND_COUNTER} from '@app/api/feed/discover/FeedTrendService';
import {feedDayAt} from '@app/api/feed/FeedRepository';
import {createPost} from '@app/api/feed/tests/FeedTestUtils';
import {counterKey, counterPartition} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import {
	getFeedDiscoverRepository,
	getFeedPostService,
	getFeedTrendService,
	getKVCounterService,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import type {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const CAP_LOG = 'Keşfet counted likers cap reached; sampling 1 in 16 from here';

let sequence = 0;
// Unique snowflakes at a chosen time; worker 7 keeps them apart from the IDs the services generate.
const idAt = (timestamp: number) => createSnowflake({timestamp, workerId: 7, sequence: sequence++ % 4096});

const account = (ageMs: number, now: number, patch: Partial<TrendAccount> = {}): TrendAccount => ({
	id: createUserID(idAt(now - ageMs)),
	email: 'discover@example.com',
	emailVerified: true,
	hasVerifiedPhone: false,
	flags: 0n,
	suspiciousActivityFlags: 0,
	isBot: false,
	isSystem: false,
	isUnclaimedAccount: () => false,
	...patch,
});

const feedPost = (now: number, patch: Partial<FeedPostRow> & {ageMs?: number} = {}): FeedPostRow => {
	const {ageMs = 0, ...row} = patch;
	return {
		post_id: idAt(now - ageMs),
		author_id: createUserID(idAt(now - 1000 * HOUR)),
		content: 'selam',
		media: null,
		edited_at: null,
		flags: FeedPostFlags.PUBLIC,
		...row,
	};
};

// An eligible account whose ID lands (or does not land) in the 1-in-16 liker sample.
function sampledAccount(now: number, sampled: boolean): TrendAccount {
	for (;;) {
		const candidate = account(100 * HOUR, now);
		const inSample = counterPartition('feed_trend_sample', candidate.id.toString()) % TREND_LIKER_SAMPLE === 0;
		if (inSample === sampled) return candidate;
	}
}

describe('Keşfet trend signal (FeedTrendService)', () => {
	let harness: ApiTestHarness;
	let kv: MockKVProvider;
	const service = () => getFeedTrendService();
	const repository = () => getFeedDiscoverRepository();
	const counter = (row: FeedPostRow) => getKVCounterService().get(FEED_TREND_COUNTER, row.post_id.toString());
	const isHidden = async (row: FeedPostRow) => (await kv.get(`feed:discover:hidden:${row.post_id}`)) === '1';
	const refreshMessages = () =>
		(kv.publishSpy.mock.calls as Array<[string, string]>)
			.filter(([channel]) => channel === 'feed:discover:refresh')
			.map(([, message]) => message);
	async function spendAllowance(user: TrendAccount, now: number): Promise<void> {
		for (let index = 0; index < 300; index++) await repository().countContribution(user.id, feedDayAt(now));
	}

	beforeAll(async () => {
		harness = await createApiTestHarness();
		kv = harness.kvProvider as MockKVProvider;
	});
	beforeEach(() => {
		kv.publishSpy.mockClear();
		kv.expireSpy.mockClear();
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await harness?.shutdown();
	});

	it('counts a like from an eligible stranger on a public post as 4 and its unlike as -4', async () => {
		const now = Date.now();
		const row = feedPost(now);
		const stranger = account(100 * HOUR, now);
		await service().recordLike(stranger, row, 1, now);
		expect(await counter(row)).toBe(4);
		await service().recordLike(stranger, row, -1, now);
		expect(await counter(row)).toBe(0);
	});

	it('a like on a non-public post never touches the trend counter', async () => {
		const now = Date.now();
		const row = feedPost(now, {flags: 0});
		const stranger = account(100 * HOUR, now);
		await service().recordLike(stranger, row, 1, now);
		await service().recordComment(stranger, row, now);
		await service().recordPollVote(stranger, row, now);
		await service().recordPostCreated(account(100 * HOUR, now), row, now);
		expect(await kv.get(counterKey(FEED_TREND_COUNTER, row.post_id.toString()))).toBeNull();
		expect(await kv.scard(`feed:trend:likers:${row.post_id}`)).toBe(0);
	});

	it("ignores the author's own like, fresh accounts and posts older than 72 hours", async () => {
		const now = Date.now();
		const author = account(100 * HOUR, now);
		const own = feedPost(now, {author_id: author.id});
		await service().recordLike(author, own, 1, now);
		expect(await counter(own)).toBe(0);

		const row = feedPost(now);
		await service().recordLike(account(71 * HOUR, now), row, 1, now);
		expect(await counter(row)).toBe(0);

		const old = feedPost(now, {ageMs: 73 * HOUR});
		await service().recordLike(account(100 * HOUR, now), old, 1, now);
		expect(await counter(old)).toBe(0);
	});

	it('an unlike without a counted like never lowers the counter', async () => {
		const now = Date.now();
		const row = feedPost(now);
		await service().recordLike(account(100 * HOUR, now), row, 1, now);
		expect(await counter(row)).toBe(4);
		// Liked while fresh (not counted), taken back once old enough: no -4 debt.
		const fresh = account(71 * HOUR, now);
		await service().recordLike(fresh, row, 1, now);
		await service().recordLike(fresh, row, -1, now + 2 * HOUR);
		expect(await counter(row)).toBe(4);

		const other = feedPost(now);
		const liker = account(100 * HOUR, now);
		const seen: Array<number> = [];
		for (const direction of [1, -1, 1] as const) {
			await service().recordLike(liker, other, direction, now);
			seen.push(await counter(other));
		}
		expect(seen).toEqual([4, 0, 4]);
	});

	it('past 100 K counted likers only 1 in 16 accounts counts, 16 times, and the cap is logged once', async () => {
		const now = Date.now();
		const row = feedPost(now);
		const likersKey = `feed:trend:likers:${row.post_id}`;
		const scard = kv.scard.bind(kv);
		let likerSetSize = TREND_MAX_COUNTED_LIKERS - 1;
		vi.spyOn(kv, 'scard').mockImplementation(async (key) => (key === likersKey ? likerSetSize : scard(key)));
		const info = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'info');
		const capLogs = () => (info.mock.calls as Array<Array<unknown>>).filter((call) => call[1] === CAP_LOG);

		await service().recordLike(account(100 * HOUR, now), row, 1, now);
		expect(await counter(row)).toBe(4);
		likerSetSize = TREND_MAX_COUNTED_LIKERS;

		const sampled = sampledAccount(now, true);
		await service().recordLike(sampled, row, 1, now);
		expect(await counter(row)).toBe(4 + 4 * TREND_LIKER_SAMPLE);
		expect(await kv.sismember(`feed:trend:likers:s:${row.post_id}`, sampled.id.toString())).toBe(1);

		await service().recordLike(sampledAccount(now, false), row, 1, now);
		expect(await counter(row)).toBe(4 + 4 * TREND_LIKER_SAMPLE);

		await service().recordLike(sampled, row, -1, now);
		expect(await counter(row)).toBe(4);
		expect(await kv.sismember(`feed:trend:likers:s:${row.post_id}`, sampled.id.toString())).toBe(0);
		expect(capLogs()).toHaveLength(1);
	});

	it("reaction sets expire with the post's 72 hours, not with the last reaction", async () => {
		const now = Date.now();
		const row = feedPost(now, {ageMs: 10 * HOUR});
		const likersKey = `feed:trend:likers:${row.post_id}`;
		await service().recordLike(account(100 * HOUR, now), row, 1, now);
		const created = await kv.ttl(likersKey);
		expect(created).toBeLessThanOrEqual(62 * 3600);
		expect(created).toBeGreaterThan(61 * 3600);

		await service().recordLike(account(100 * HOUR, now), row, 1, now + HOUR);
		expect(await kv.scard(likersKey)).toBe(2);
		expect(await kv.ttl(likersKey)).toBeLessThanOrEqual(created);
	});

	it('a reaction set and a daily count get their lifetime in the same step as their first write', async () => {
		const now = Date.now();
		const row = feedPost(now);
		const liker = account(100 * HOUR, now);
		// A lost EXPIRE (once a separate step after the first write) must not leave either key without a lifetime.
		vi.spyOn(kv, 'expire').mockRejectedValueOnce(new Error('kv'));
		await service().recordLike(liker, row, 1, now);
		expect(await kv.ttl(`feed:trend:daily:${liker.id}:${feedDayAt(now)}`)).toBeGreaterThan(0);
		// Liking again (already counted) sets the set's lifetime the lost step did not.
		await service().recordLike(liker, row, 1, now);
		expect(await kv.ttl(`feed:trend:likers:${row.post_id}`)).toBeGreaterThan(0);
	});

	it("a reporter's reports spend their own 10 a day, apart from the 300 reactions", async () => {
		const now = Date.now();
		const reporter = account(100 * HOUR, now);
		await spendAllowance(reporter, now);
		const rows = Array.from({length: 11}, () => feedPost(now));
		for (const row of rows) await service().recordReport(reporter, row, now);
		const counted = await Promise.all(rows.map((row) => kv.scard(`feed:discover:reports:${row.post_id}`)));
		expect(counted).toEqual([...Array<number>(10).fill(1), 0]);

		// Reporting never spends the reaction allowance.
		const other = account(100 * HOUR, now);
		for (let index = 0; index < 10; index++) await service().recordReport(other, feedPost(now), now);
		expect(await kv.get(`feed:trend:daily:${other.id}:${feedDayAt(now)}`)).toBeNull();
	});

	it('a moderator restore takes back the hide and its reports, ranks the post again and keeps reports from hiding it for 72 hours', async () => {
		const now = Date.now();
		const row = feedPost(now);
		const id = row.post_id.toString();
		await repository().putTrendState(row.post_id, {L: 7, hw: 4, v: 4});
		await repository().rankPost(row.post_id, 7);
		for (let index = 0; index < 3; index++) await service().recordReport(account(100 * HOUR, now), row, now);
		expect(await isHidden(row)).toBe(true);
		expect(await kv.zrangebyscore('feed:discover:z', '-inf', '+inf')).not.toContain(id);

		await service().restorePost(row.post_id);
		expect(await isHidden(row)).toBe(false);
		expect(await kv.scard(`feed:discover:reports:${id}`)).toBe(0);
		expect(await kv.zrangebyscore('feed:discover:z', -7, -7)).toContain(id);
		expect(await kv.ttl(`feed:discover:cleared:${id}`)).toBeGreaterThan(71 * 3600);

		kv.publishSpy.mockClear();
		for (let index = 0; index < 3; index++) await service().recordReport(account(100 * HOUR, now), row, now);
		expect(await isHidden(row)).toBe(false);
		expect(refreshMessages()).toEqual([]);
	});

	it('a post with 5 000 counted likers needs 5 eligible reporters to hide', async () => {
		const now = Date.now();
		const row = feedPost(now);
		vi.spyOn(repository(), 'countLikers').mockResolvedValue(5000);
		for (let index = 0; index < 4; index++) await service().recordReport(account(100 * HOUR, now), row, now);
		expect(await isHidden(row)).toBe(false);
		await service().recordReport(account(100 * HOUR, now), row, now);
		expect(await isHidden(row)).toBe(true);
	});

	it("counts only an account's first comment on a post, as 12", async () => {
		const now = Date.now();
		const row = feedPost(now);
		const commenter = account(100 * HOUR, now);
		await service().recordComment(commenter, row, now);
		await service().recordComment(commenter, row, now);
		expect(await counter(row)).toBe(12);
	});

	it('stops counting an account after 300 contributions a day', async () => {
		const now = Date.now();
		const row = feedPost(now);
		const busy = account(100 * HOUR, now);
		await spendAllowance(busy, now);
		await service().recordLike(busy, row, 1, now);
		expect(await counter(row)).toBe(0);
	});

	it('counts an account toward one author at most 3 times a day; taking back what counted is never capped', async () => {
		const now = Date.now();
		const author = createUserID(idAt(now - 1000 * HOUR));
		const posts = Array.from({length: 4}, () => feedPost(now, {author_id: author}));
		const fan = account(100 * HOUR, now);
		for (const row of posts) await service().recordLike(fan, row, 1, now);
		expect(await Promise.all(posts.map(counter))).toEqual([4, 4, 4, 0]);

		const other = feedPost(now);
		await service().recordLike(fan, other, 1, now);
		expect(await counter(other)).toBe(4);
		await service().recordLike(fan, posts[0]!, -1, now);
		expect(await counter(posts[0]!)).toBe(0);
	});

	it("starts an eligible author's public post at 2 and a fresh author's at 0", async () => {
		const now = Date.now();
		const author = account(25 * HOUR, now);
		const row = feedPost(now, {author_id: author.id});
		await service().recordPostCreated(author, row, now);
		expect(await counter(row)).toBe(2);

		const fresh = account(HOUR, now);
		const freshRow = feedPost(now, {author_id: fresh.id});
		await service().recordPostCreated(fresh, freshRow, now);
		expect(await counter(freshRow)).toBe(0);
	});

	it('hides a public post from Keşfet after three different eligible reporters and publishes the eviction', async () => {
		const now = Date.now();
		const row = feedPost(now);
		const id = row.post_id.toString();
		await repository().rankPost(row.post_id, 5);
		const first = account(100 * HOUR, now);
		await service().recordReport(first, row, now);
		await service().recordReport(first, row, now);
		await service().recordReport(account(100 * HOUR, now), row, now);
		expect(await isHidden(row)).toBe(false);
		expect(refreshMessages()).toEqual([]);

		await service().recordReport(account(100 * HOUR, now), row, now);
		expect(await isHidden(row)).toBe(true);
		expect(refreshMessages()).toEqual([`post:${id}`]);
		expect(await kv.zrangebyscore('feed:discover:evicted', '-inf', '+inf')).toContain(`post:${id}`);
		expect(await kv.zrangebyscore('feed:discover:z', '-inf', '+inf')).not.toContain(id);
	});

	it('reports from fresh accounts do not hide a post', async () => {
		const now = Date.now();
		const row = feedPost(now);
		for (let index = 0; index < 3; index++) await service().recordReport(account(HOUR, now), row, now);
		expect(await isHidden(row)).toBe(false);
		expect(await kv.scard(`feed:discover:reports:${row.post_id}`)).toBe(0);
	});

	it('evicts only public posts inside the 72 hour window, and a whole author with one message', async () => {
		const now = Date.now();
		await service().evictPost(feedPost(now, {ageMs: 73 * HOUR}), now);
		await service().evictPost(feedPost(now, {flags: 0}), now);
		expect(refreshMessages()).toEqual([]);
		const fresh = feedPost(now);
		await service().evictPost(fresh, now);
		expect(refreshMessages()).toEqual([`post:${fresh.post_id}`]);

		kv.publishSpy.mockClear();
		const author = createUserID(idAt(now - 1000 * HOUR));
		await service().evictAuthor(author);
		expect(refreshMessages()).toEqual([`author:${author}`]);
		expect(await kv.zrangebyscore('feed:discover:evicted', '-inf', '+inf')).toContain(`author:${author}`);
	});

	it('flushing the counter ranks the post by -L and keeps the high-water mark', async () => {
		const now = Date.now();
		const flusher = createFeedTrendCounterFlusher(repository(), () => now);
		const quiet = feedPost(now).post_id;
		const busy = feedPost(now).post_id;
		await flusher.flush(quiet.toString(), 4);
		await flusher.flush(busy.toString(), 16);
		const ranked = async () =>
			(await kv.zrangebyscore('feed:discover:z', '-inf', '+inf')).filter(
				(member) => member === quiet.toString() || member === busy.toString(),
			);
		expect(await ranked()).toEqual([busy.toString(), quiet.toString()]);

		const before = await repository().getTrendState(quiet);
		await flusher.flush(quiet.toString(), 0);
		expect(await flusher.readBase(quiet.toString())).toBe(0);
		await flusher.flush(quiet.toString(), 4);
		const after = await repository().getTrendState(quiet);
		expect(after).toEqual({L: before!.L, hw: 4, v: 4});
		expect(await ranked()).toEqual([busy.toString(), quiet.toString()]);
	});

	it('a flush whose ranking write fails keeps the high-water mark, so the next flush ranks the post', async () => {
		const now = Date.now();
		const flusher = createFeedTrendCounterFlusher(repository(), () => now);
		const postId = feedPost(now).post_id;
		vi.spyOn(repository(), 'rankPost').mockRejectedValueOnce(new Error('kv'));

		await expect(flusher.flush(postId.toString(), 4)).rejects.toThrow('kv');
		await flusher.flush(postId.toString(), 4);
		expect(await kv.zrangebyscore('feed:discover:z', '-inf', '+inf')).toContain(postId.toString());
		expect(await repository().getTrendState(postId)).toMatchObject({hw: 4, v: 4});
	});

	it('the trend counter refuses a recount', async () => {
		const flusher = createFeedTrendCounterFlusher(repository());
		await expect(flusher.recount('1')).rejects.toThrow();
	});

	it('trims the ranking by its excess over 200 K, not a fixed 10 K, and says how many it trimmed', async () => {
		const zcard = vi.spyOn(kv, 'zcard');
		vi.spyOn(kv, 'zrangebyscore').mockImplementation(async (_key, _min, _max, ...args) =>
			Array.from({length: Number(args[2])}, (_, index) => `tail-${index}`),
		);
		const zrem = vi.spyOn(kv, 'zrem').mockResolvedValue(0);

		zcard.mockResolvedValue(200_025);
		expect(await repository().pruneRanked()).toEqual({ranked: 200_025, pruned: 25});
		zcard.mockResolvedValue(215_000);
		zrem.mockClear();
		expect(await repository().pruneRanked()).toEqual({ranked: 215_000, pruned: 15_000});
		expect(zrem).toHaveBeenCalledTimes(2);
		zcard.mockResolvedValue(900_000);
		expect((await repository().pruneRanked()).pruned).toBe(100_000);
	});

	it('a failing KV call never throws out of a record method', async () => {
		const now = Date.now();
		vi.spyOn(repository(), 'countContribution').mockRejectedValue(new Error('kv'));
		await expect(service().recordLike(account(100 * HOUR, now), feedPost(now), 1, now)).resolves.toBeUndefined();
		await expect(service().recordReport(account(100 * HOUR, now), feedPost(now), now)).resolves.toBeUndefined();
		vi.spyOn(repository(), 'publishEvict').mockRejectedValue(new Error('kv'));
		await expect(service().evictAuthor(createUserID(idAt(now)))).resolves.toBeUndefined();
	});

	it('the like and unlike routes answer once their trend write is done; comment and vote do not wait', async () => {
		const trend = service();
		const never = new Promise<void>(() => {});
		for (const method of ['recordComment', 'recordPollVote'] as const) {
			vi.spyOn(trend, method).mockReturnValue(never);
		}
		const likeWrites: Array<1 | -1> = [];
		vi.spyOn(trend, 'recordLike').mockImplementation(async (_actor, _post, direction) => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			likeWrites.push(direction);
		});
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		const post = await createPost(harness, alice, {
			content: 'Hangisi?',
			public: true,
			poll: {options: ['Elma', 'Armut'], duration_hours: 24},
		}).execute();
		const asBob = () => createBuilder(harness, bob.token);

		await asBob().put(`/feed/posts/${post.id}/like`).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(likeWrites).toEqual([1]);
		await asBob().delete(`/feed/posts/${post.id}/like`).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(likeWrites).toEqual([1, -1]);
		await asBob().post(`/feed/posts/${post.id}/comments`).body({content: 'selam'}).expect(HTTP_STATUS.OK).execute();
		await asBob().put(`/feed/posts/${post.id}/poll/vote`).body({option: 0}).expect(HTTP_STATUS.OK).execute();
	}, 3000);

	it('a quick like then unlike through the routes leaves no trend weight and no counted liker behind', async () => {
		const trend = service();
		const record = trend.recordLike.bind(trend);
		// Test accounts are too fresh to count, so an eligible stand-in carries Bob's like into the real signal.
		const standIn = account(100 * HOUR, Date.now());
		const writes: Array<Promise<void>> = [];
		vi.spyOn(trend, 'recordLike').mockImplementation((_actor, post, direction) => {
			const write = (async () => {
				// The like's write is the slower one (more KV calls than the unlike's); a slow KV stretches it further.
				if (direction === 1) await new Promise((resolve) => setTimeout(resolve, 50));
				await record(standIn, post, direction);
			})();
			writes.push(write);
			return write;
		});
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		const post = await createPost(harness, alice, {content: 'herkese', public: true}).execute();
		const trendWeight = () => getKVCounterService().get(FEED_TREND_COUNTER, post.id);
		const weightBefore = await trendWeight();
		const asBob = () => createBuilder(harness, bob.token);

		await asBob().put(`/feed/posts/${post.id}/like`).expect(HTTP_STATUS.NO_CONTENT).execute();
		await asBob().delete(`/feed/posts/${post.id}/like`).expect(HTTP_STATUS.NO_CONTENT).execute();
		await Promise.all(writes);

		expect(writes).toHaveLength(2);
		expect(await trendWeight()).toBe(weightBefore);
		expect(await kv.scard(`feed:trend:likers:${post.id}`)).toBe(0);
	});

	it('the post, like, comment, report and delete routes and account deletion hand their signal to Keşfet', async () => {
		const trend = service();
		const spies = {
			created: vi.spyOn(trend, 'recordPostCreated'),
			like: vi.spyOn(trend, 'recordLike'),
			comment: vi.spyOn(trend, 'recordComment'),
			report: vi.spyOn(trend, 'recordReport'),
			evictPost: vi.spyOn(trend, 'evictPost'),
			evictAuthor: vi.spyOn(trend, 'evictAuthor'),
		};
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		// Bob is brand new: as a stranger he could not comment on Alice's public post.
		await createFriendship(harness, alice, bob);
		const aliceId = createUserID(BigInt(alice.userId));
		const bobId = createUserID(BigInt(bob.userId));
		const post = await createPost(harness, alice, {content: 'herkese', public: true}).execute();
		const postRow = expect.objectContaining({post_id: BigInt(post.id)});
		expect(spies.created).toHaveBeenCalledWith(expect.objectContaining({id: aliceId}), postRow);

		const asBob = () => createBuilder(harness, bob.token);
		for (let index = 0; index < 2; index++) {
			await asBob().put(`/feed/posts/${post.id}/like`).expect(HTTP_STATUS.NO_CONTENT).execute();
		}
		for (let index = 0; index < 2; index++) {
			await asBob().delete(`/feed/posts/${post.id}/like`).expect(HTTP_STATUS.NO_CONTENT).execute();
		}
		expect(spies.like.mock.calls.map((call) => call[2])).toEqual([1, -1]);
		expect(spies.like).toHaveBeenCalledWith(expect.objectContaining({id: bobId}), postRow, 1);

		await asBob().post(`/feed/posts/${post.id}/comments`).body({content: 'selam'}).expect(HTTP_STATUS.OK).execute();
		expect(spies.comment).toHaveBeenCalledWith(expect.objectContaining({id: bobId}), postRow);
		await asBob()
			.post('/reports/feed-post')
			.body({post_id: post.id, category: 'spam'})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(spies.report).toHaveBeenCalledWith(expect.objectContaining({id: bobId}), postRow);

		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(spies.evictPost).toHaveBeenCalledWith(postRow);

		// Account deletion: one author eviction, no eviction per post.
		await createPost(harness, alice, {content: 'bir daha', public: true}).execute();
		spies.evictPost.mockClear();
		await getFeedPostService().deleteUserPosts(aliceId);
		expect(spies.evictAuthor.mock.calls).toEqual([[aliceId]]);
		expect(spies.evictPost).not.toHaveBeenCalled();
	});
});
