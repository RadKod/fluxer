// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {
	acceptInvite,
	createChannelInvite,
	createGuild,
	setupTestGuildWithMembers,
} from '@app/api/channel/tests/ChannelTestUtils';
import {
	captureJobs,
	createPost,
	followDirectly,
	getHome,
	type QueuedJob,
	runFanout,
} from '@app/api/feed/tests/FeedTestUtils';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {Logger} from '@app/api/Logger';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {getFeedRepository, getFeedTimelineService, getKVCounterService} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserAccountLookupService} from '@app/api/user/services/UserAccountLookupService';
import {createSnowflakeFromTimestamp} from '@fluxer/snowflake/src/Snowflake';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const DAY_MS = 86_400_000;
const FANOUT_MAX_FOLLOWERS = 10_000;

// Every CQL statement the request runs, single statements and batch members alike.
function spyOnCql(): () => Array<string> {
	const single = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeQuery');
	const batch = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeBatch');
	return () => [
		...single.mock.calls.map(([query]) => query.cql),
		...batch.mock.calls.flatMap(([queries]) => queries.map((query) => query.query)),
	];
}

function celebrityPartitionReads(cql: Array<string>): number {
	return cql.filter((statement) => /^SELECT .* FROM feed_posts_by_author /i.test(statement)).length;
}

// What a home request reads for pulled authors. Their newest-post lists live in process memory (polled from KV every
// 15 s, never per request), so a page reads only its own posts (the KV post cache, then feed_posts) and no author list
// or author partition.
function spyOnPulledReads(): () => {lists: number; posts: number; authorPartitions: number} {
	const statements = spyOnCql();
	const mget = vi.spyOn(getKVClient(), 'mget');
	const get = vi.spyOn(getKVClient(), 'get');
	return () => {
		const keys = [...mget.mock.calls.flat(), ...get.mock.calls.map(([key]) => key)];
		return {
			lists: keys.filter((key) => key.startsWith('feed:celebrity:recent:')).length,
			posts: keys.filter((key) => key.startsWith('feed:post:')).length,
			authorPartitions: celebrityPartitionReads(statements()),
		};
	};
}

function homePartitionReads(cql: Array<string>): number {
	return cql.filter((statement) => /^SELECT .* FROM feed_home /i.test(statement)).length;
}

function fanoutJobs(jobs: Array<QueuedJob>): Array<QueuedJob> {
	return jobs.filter((job) => job.task === 'fanoutFeedPost');
}

describe('feed fan-out of large accounts (Review Focus 2)', () => {
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

	async function setFollowerCount(account: TestAccount, count: number): Promise<void> {
		const counters = getKVCounterService();
		await counters.add(
			FOLLOWER_COUNT_COUNTER,
			account.userId,
			count - (await counters.get(FOLLOWER_COUNT_COUNTER, account.userId)),
		);
	}

	// A community the viewer owns: the home feed shows only authors whose profile the viewer may see.
	async function communityInvite(viewer: TestAccount): Promise<string> {
		const guild = await createGuild(harness, viewer.token, 'Akış');
		return (await createChannelInvite(harness, viewer.token, guild.system_channel_id!)).code;
	}

	async function celebrityPosting(viewer: TestAccount, invite: string, content: string): Promise<string> {
		const star = await createTestAccount(harness);
		await acceptInvite(harness, star.token, invite);
		await followDirectly(viewer.userId, star.userId);
		await setFollowerCount(star, 20_000);
		return (await createPost(harness, star, {content}).execute()).id;
	}

	it('writes no home row and queues no fan-out for a 20K follower author, and followers pull the post', async () => {
		const {owner: star, members} = await setupTestGuildWithMembers(harness, 1);
		const fan = members[0]!;
		await createBuilder(harness, fan.token)
			.put(`/users/${star.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await setFollowerCount(star, 20_000);
		const jobs = captureJobs();
		const statements = spyOnCql();

		const post = await createPost(harness, star, {content: 'milyonlara'}).execute();

		expect(fanoutJobs(jobs)).toEqual([]);
		expect(statements().filter((cql) => cql.includes('feed_home'))).toEqual([]);
		await getFeedTimelineService().refreshCelebrities();
		expect((await getHome(harness, fan).execute()).map((entry) => entry.id)).toEqual([post.id]);
	});

	it('keeps an author pulled until the followers drop below feed_fanout_min_followers', async () => {
		const star = await createTestAccount(harness);
		const jobs = captureJobs();

		await setFollowerCount(star, FANOUT_MAX_FOLLOWERS);
		await createPost(harness, star, {content: 'eşikte, yazılır'}).execute();
		expect(fanoutJobs(jobs.splice(0))).toHaveLength(1);

		await setFollowerCount(star, FANOUT_MAX_FOLLOWERS + 1);
		await createPost(harness, star, {content: 'ünlü oldu'}).execute();
		expect(fanoutJobs(jobs.splice(0))).toEqual([]);

		await setFollowerCount(star, 8000);
		await createPost(harness, star, {content: 'hâlâ çekiliyor'}).execute();
		expect(fanoutJobs(jobs.splice(0))).toEqual([]);

		await setFollowerCount(star, 7999);
		await createPost(harness, star, {content: 'yeniden yazılıyor'}).execute();
		expect(fanoutJobs(jobs.splice(0))).toHaveLength(1);
	});

	it('reads only the page posts when 300 celebrities are followed and 3 posted', async () => {
		const viewer = await createTestAccount(harness);
		const oldPost = createSnowflakeFromTimestamp(Date.now() - 40 * DAY_MS);
		for (let index = 0; index < 297; index++) {
			const quiet = createUserID(await getSnowflakeService().generate());
			await followDirectly(viewer.userId, quiet.toString());
			await getFeedRepository().addCelebrityPost(quiet, oldPost);
		}
		const invite = await communityInvite(viewer);
		const posted: Array<string> = [];
		for (let index = 0; index < 3; index++) {
			posted.unshift(await celebrityPosting(viewer, invite, `ünlü ${index}`));
		}
		await getFeedTimelineService().refreshCelebrities();
		const reads = spyOnPulledReads();

		const page = await getHome(harness, viewer, '?limit=50').execute();

		expect(page.map((entry) => entry.id)).toEqual(posted);
		expect(reads()).toEqual({lists: 0, posts: 3, authorPartitions: 0});
	});

	it('checks profile access once per reader and author, then trusts the cached verdict (S-2)', async () => {
		const viewer = await createTestAccount(harness);
		const invite = await communityInvite(viewer);
		for (let index = 0; index < 3; index++) {
			await celebrityPosting(viewer, invite, `ünlü ${index}`);
		}
		await getFeedTimelineService().refreshCelebrities();
		const checks = vi.spyOn(UserAccountLookupService.prototype, 'resolveProfileAccess');

		expect(await getHome(harness, viewer).execute()).toHaveLength(3);
		expect(checks).toHaveBeenCalledTimes(3);
		expect(await getHome(harness, viewer).execute()).toHaveLength(3);
		expect(checks).toHaveBeenCalledTimes(3);
	});

	it('prunes authors whose pulled list last changed before the home window from the change index', async () => {
		const kv = getKVClient();
		const stale = (await getSnowflakeService().generate()).toString();
		const recent = (await getSnowflakeService().generate()).toString();
		await kv.zadd('feed:celebrities', Date.now() - 32 * DAY_MS, stale);
		await kv.zadd('feed:celebrities', Date.now() - 29 * DAY_MS, recent);

		await getFeedTimelineService().refreshCelebrities();

		const members = await kv.zrangebyscore('feed:celebrities', '-inf', '+inf');
		expect(members).not.toContain(stale);
		expect(members).toContain(recent);
	});

	it('reads at most the window of home partitions for a cursor far in the future', async () => {
		const viewer = await createTestAccount(harness);
		await followDirectly(viewer.userId, (await getSnowflakeService().generate()).toString());
		const statements = spyOnCql();

		const page = await getHome(harness, viewer, '?limit=50&before=9223372036854775806').execute();

		expect(page).toEqual([]);
		expect(homePartitionReads(statements())).toBeLessThanOrEqual(32);
	});

	it('reads a bounded number of home partitions for limit=1 over 1000 rows of unfollowed authors', async () => {
		const viewer = await createTestAccount(harness);
		const viewerId = createUserID(BigInt(viewer.userId));
		await followDirectly(viewer.userId, (await getSnowflakeService().generate()).toString());
		const unfollowed = createUserID(await getSnowflakeService().generate());
		for (let index = 0; index < 1000; index++) {
			await getFeedRepository().addToHomes([viewerId], await getSnowflakeService().generate(), unfollowed);
		}
		const statements = spyOnCql();

		const page = await getHome(harness, viewer, '?limit=1').execute();

		expect(page).toEqual([]);
		expect(homePartitionReads(statements())).toBeLessThanOrEqual(53);
	});

	it('gives X-Next-Before when the read budget ends a page early, so older posts stay reachable', async () => {
		const viewer = await createTestAccount(harness);
		const viewerId = createUserID(BigInt(viewer.userId));
		const invite = await communityInvite(viewer);
		const author = await createTestAccount(harness);
		await acceptInvite(harness, author.token, invite);
		await followDirectly(viewer.userId, author.userId);
		const jobs = captureJobs();
		const older = await createPost(harness, author, {content: 'eski'}).execute();
		await runFanout(jobs);
		// 22 full pages of an unfollowed author above it: past the 21 pages one request may read.
		const unfollowed = createUserID(await getSnowflakeService().generate());
		for (let index = 0; index < 1100; index++) {
			await getFeedRepository().addToHomes([viewerId], await getSnowflakeService().generate(), unfollowed);
		}
		const statements = spyOnCql();

		const first = await getHome(harness, viewer, '?limit=1').executeWithResponse();
		expect(first.json).toEqual([]);
		expect(homePartitionReads(statements())).toBeLessThanOrEqual(53);
		const next = first.response.headers.get('X-Next-Before');
		expect(next).not.toBeNull();
		const second = await getHome(harness, viewer, `?limit=1&before=${next}`).executeWithResponse();

		expect(second.json.map((post) => post.id)).toEqual([older.id]);
		expect(second.response.headers.get('X-Next-Before')).toBe(older.id);
	});

	it('gives X-Next-Before past a full page of deleted posts, and none once the feed ends', async () => {
		const viewer = await createTestAccount(harness);
		const invite = await communityInvite(viewer);
		const author = await createTestAccount(harness);
		await acceptInvite(harness, author.token, invite);
		await followDirectly(viewer.userId, author.userId);
		const jobs = captureJobs();
		const older = await createPost(harness, author, {content: 'kalan'}).execute();
		const deleted = await createPost(harness, author, {content: 'silinen'}).execute();
		await runFanout(jobs);
		await createBuilder(harness, author.token)
			.delete(`/feed/posts/${deleted.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		const first = await getHome(harness, viewer, '?limit=1').executeWithResponse();
		expect(first.json).toEqual([]);
		expect(first.response.headers.get('X-Next-Before')).toBe(deleted.id);
		const second = await getHome(harness, viewer, `?limit=1&before=${deleted.id}`).execute();
		expect(second.map((post) => post.id)).toEqual([older.id]);
		const last = await getHome(harness, viewer, `?limit=1&before=${older.id}`).executeWithResponse();

		expect(last.json).toEqual([]);
		expect(last.response.headers.get('X-Next-Before')).toBeNull();
	});

	it('checks profile access for only the authors a limit=1 home page needs', async () => {
		const viewer = await createTestAccount(harness);
		const invite = await communityInvite(viewer);
		const jobs = captureJobs();
		for (let index = 0; index < 3; index++) {
			const author = await createTestAccount(harness);
			await acceptInvite(harness, author.token, invite);
			await followDirectly(viewer.userId, author.userId);
			await createPost(harness, author, {content: `yazar ${index}`}).execute();
		}
		await runFanout(jobs);
		const checks = vi.spyOn(UserAccountLookupService.prototype, 'resolveProfileAccess');

		expect(await getHome(harness, viewer, '?limit=1').execute()).toHaveLength(1);
		expect(checks).toHaveBeenCalledTimes(1);
	});

	it('checks hidden authors 8 at a time after the first check of a limit=1 home page', async () => {
		const viewer = await createTestAccount(harness);
		const viewerId = createUserID(BigInt(viewer.userId));
		// Strangers: no shared community, so the viewer may not see their profiles and every author is hidden.
		for (let index = 0; index < 20; index++) {
			const stranger = await createTestAccount(harness);
			await followDirectly(viewer.userId, stranger.userId);
			const strangerId = createUserID(BigInt(stranger.userId));
			await getFeedRepository().addToHomes([viewerId], await getSnowflakeService().generate(), strangerId);
		}
		const resolveProfileAccess = UserAccountLookupService.prototype.resolveProfileAccess;
		let running = 0;
		let mostAtOnce = 0;
		const checks = vi
			.spyOn(UserAccountLookupService.prototype, 'resolveProfileAccess')
			.mockImplementation(async function (this: UserAccountLookupService, ...args) {
				running++;
				mostAtOnce = Math.max(mostAtOnce, running);
				try {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return await resolveProfileAccess.apply(this, args);
				} finally {
					running--;
				}
			});

		expect(await getHome(harness, viewer, '?limit=1').execute()).toEqual([]);
		expect(checks).toHaveBeenCalledTimes(20);
		expect(mostAtOnce).toBe(8);
	});

	// Followed authors with no account behind them: the users read finds none, so each is hidden and uses one author check.
	async function followHiddenAuthors(viewer: TestAccount, count: number): Promise<void> {
		const viewerId = createUserID(BigInt(viewer.userId));
		for (let index = 0; index < count; index++) {
			const hidden = createUserID(await getSnowflakeService().generate());
			await followDirectly(viewer.userId, hidden.toString());
			await getFeedRepository().addToHomes([viewerId], await getSnowflakeService().generate(), hidden);
		}
	}

	it('gives X-Next-Before at the row the author check budget could not judge, which the next page shows', async () => {
		const viewer = await createTestAccount(harness);
		const invite = await communityInvite(viewer);
		const author = await createTestAccount(harness);
		await acceptInvite(harness, author.token, invite);
		await followDirectly(viewer.userId, author.userId);
		const jobs = captureJobs();
		const older = await createPost(harness, author, {content: 'eski'}).execute();
		await runFanout(jobs);
		// 100 hidden authors above it spend the budget, so the visible author is the 101st and is not judged.
		await followHiddenAuthors(viewer, 100);

		const first = await getHome(harness, viewer, '?limit=1').executeWithResponse();
		expect(first.json).toEqual([]);
		expect(first.response.headers.get('X-Next-Before')).toBe((BigInt(older.id) + 1n).toString());
		const second = await getHome(harness, viewer, `?limit=1&before=${BigInt(older.id) + 1n}`).execute();

		expect(second.map((post) => post.id)).toEqual([older.id]);
	});

	it('gives no X-Next-Before when the author check budget stops before a pulled author (GEÇİCİ)', async () => {
		const viewer = await createTestAccount(harness);
		const invite = await communityInvite(viewer);
		await followHiddenAuthors(viewer, 101);
		await celebrityPosting(viewer, invite, 'ünlü');
		await getFeedTimelineService().refreshCelebrities();

		const page = await getHome(harness, viewer, '?limit=1').executeWithResponse();

		expect(page.json).toEqual([]);
		expect(page.response.headers.get('X-Next-Before')).toBeNull();
	});

	it('reads only the page posts, no author list or partition, when 50 followed celebrities posted', async () => {
		const viewer = await createTestAccount(harness);
		const invite = await communityInvite(viewer);
		const posted: Array<string> = [];
		for (let index = 0; index < 50; index++) {
			posted.unshift(await celebrityPosting(viewer, invite, `ünlü ${index}`));
		}
		await getFeedTimelineService().refreshCelebrities();
		const reads = spyOnPulledReads();

		const first = await getHome(harness, viewer, '?limit=30').execute();
		expect(reads()).toEqual({lists: 0, posts: 30, authorPartitions: 0});
		const second = await getHome(harness, viewer, `?limit=30&before=${first.at(-1)!.id}`).execute();

		expect([...first, ...second].map((entry) => entry.id)).toEqual(posted);
		expect(reads()).toEqual({lists: 0, posts: 50, authorPartitions: 0});
	});

	// Last: it moves the clock forward (only Date), which the pulled author poll then remembers.
	it('logs the home pages a budget cut, at most once a minute, for the GEÇİCİ triggers', async () => {
		const viewer = await createTestAccount(harness);
		const viewerId = createUserID(BigInt(viewer.userId));
		await followDirectly(viewer.userId, (await getSnowflakeService().generate()).toString());
		const unfollowed = createUserID(await getSnowflakeService().generate());
		for (let index = 0; index < 1100; index++) {
			await getFeedRepository().addToHomes([viewerId], await getSnowflakeService().generate(), unfollowed);
		}
		const info = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'info');
		const cutLogs = () =>
			(info.mock.calls as Array<Array<unknown>>).filter((call) => call[1] === 'Feed home pages cut by a budget');
		vi.useFakeTimers({toFake: ['Date']});
		try {
			vi.setSystemTime(Date.now() + 61_000);
			await getHome(harness, viewer, '?limit=1').execute();
			info.mockClear();

			await getHome(harness, viewer, '?limit=1').execute();
			expect(cutLogs()).toEqual([]);
			vi.setSystemTime(Date.now() + 61_000);
			await getHome(harness, viewer, '?limit=1').execute();
		} finally {
			vi.useRealTimers();
		}

		expect(cutLogs()).toEqual([
			[{pages: 2, read_budget: 2, author_budget: 0, pulled_author_budget: 0}, 'Feed home pages cut by a budget'],
		]);
	});
});
