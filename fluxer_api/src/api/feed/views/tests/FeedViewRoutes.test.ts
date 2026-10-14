// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {feedDiscoverCache} from '@app/api/feed/discover/FeedDiscoverCache';
import {FEED_TREND_COUNTER} from '@app/api/feed/discover/FeedTrendService';
import {FEED_VIEW_COUNT_COUNTER} from '@app/api/feed/interaction/FeedInteractionCounters';
import {createPost, getHome, overrideLimits, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {FeedViewController} from '@app/api/feed/views/FeedViewController';
import {signFeedViewTicket, verifyFeedViewTicket} from '@app/api/feed/views/FeedViews';
import {extractStringValues} from '@app/api/middleware/ContentFilterMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedDiscoverRepository,
	getFeedTimelineService,
	getFeedViewService,
	getKVCounterService,
	getLimitConfigService,
	getUserRepository,
	resetServiceSingletonsForTesting,
	shutdownServiceSingletons,
} from '@app/api/middleware/ServiceSingletons';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {FeedPostListResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {Hono} from 'hono';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const HTTP_TOO_MANY_REQUESTS = 429;
const RATE_LIMITS_ON = 'x-fluxer-test-enable-rate-limits';
const GLOBAL_LIMIT = 'x-fluxer-test-global-rate-limit';

interface View {
	id: string;
	token: string;
}

describe('POST /feed/views and view counts on post responses', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	const viewsOn = () => overrideLimits({feature_feed_views: 1});
	const getPost = (viewer: TestAccount, postId: string) =>
		createBuilder<FeedPostResponse>(harness, viewer.token).get(`/feed/posts/${postId}`).execute();
	const sendViews = (viewer: TestAccount, views: Array<View>) =>
		createBuilder(harness, viewer.token).post('/feed/views').body({views});
	const viewOf = (post: FeedPostResponse): View => ({id: post.id, token: post.view_token!});
	const storedViews = (postId: string) => getKVCounterService().get(FEED_VIEW_COUNT_COUNTER, postId);
	const flushViews = () => getFeedViewService().flush();
	const userId = (account: TestAccount) => createUserID(BigInt(account.userId));
	// A public post (written while its author is public), so any account may open it.
	async function publicPost(author: TestAccount): Promise<string> {
		await setProfileLevel(author, 100);
		return (await createPost(harness, author, {content: 'görüntülenme', public: true}).execute()).id;
	}
	async function seenBy(viewer: TestAccount, postId: string): Promise<View> {
		return viewOf(await getPost(viewer, postId));
	}
	async function addFlag(account: TestAccount, flag: bigint): Promise<void> {
		const id = userId(account);
		const user = (await getUserRepository().findUnique(id))!;
		await getUserRepository().patchUpsert(id, {flags: user.flags | flag}, user.toRow());
	}
	// Builds the Keşfet snapshot with `postId` in it, a day ahead so the brand-new author is old enough.
	async function discoverWith(postId: string): Promise<void> {
		await getFeedDiscoverRepository().rankPost(BigInt(postId), 10);
		await getKVClient().del('feed:discover:build');
		await getFeedTimelineService().discover.buildSnapshot(Date.now() + 25 * HOUR);
		await feedDiscoverCache.refresh();
	}
	const discover = (viewer: TestAccount) =>
		createBuilder<FeedPostListResponse>(harness, viewer.token).get('/feed/discover').execute();

	it('answers 403 and leaves view_count and view_token out while feature_feed_views is 0', async () => {
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await setProfileLevel(author, 100);
		const created = await createPost(harness, author, {content: 'kapalı', public: true}).execute();

		await sendViews(viewer, [{id: created.id, token: '1.AAAAAAAAAAAAAAAAAAAAAA'}])
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
			.execute();

		for (const post of [created, await getPost(viewer, created.id), ...(await getHome(harness, author).execute())]) {
			expect(post).not.toHaveProperty('view_count');
			expect(post).not.toHaveProperty('view_token');
		}
	});

	it('gives each post response a count and a ticket for the caller only, and none in the Discover snapshot', async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const [first, second] = [await createTestAccount(harness), await createTestAccount(harness)];
		await setProfileLevel(author, 100);
		const created = await createPost(harness, author, {content: 'bilet', public: true}).execute();
		const postId = BigInt(created.id);

		const seenByFirst = await getPost(first, created.id);
		const seenBySecond = await getPost(second, created.id);
		const [home] = await getHome(harness, author).execute();

		expect(seenByFirst.view_count).toBe(0);
		expect(home).toMatchObject({id: created.id, view_count: 0});
		const now = Date.now();
		for (const [owner, ticket] of [
			[author, created.view_token],
			[author, home!.view_token],
			[first, seenByFirst.view_token],
			[second, seenBySecond.view_token],
		] as const) {
			expect(verifyFeedViewTicket(userId(owner), postId, ticket!, now)).toBe(true);
		}
		expect(verifyFeedViewTicket(userId(second), postId, seenByFirst.view_token!, now)).toBe(false);
		expect(verifyFeedViewTicket(userId(first), postId, seenBySecond.view_token!, now)).toBe(false);

		await discoverWith(created.id);
		const entry = (await getFeedDiscoverRepository().getSnapshot())!.entries.find(
			(item) => item.post.id === created.id,
		)!;
		expect(entry.post).toHaveProperty('view_count', 0);
		expect(entry.post).not.toHaveProperty('view_token');
		expect(JSON.stringify(await getFeedDiscoverRepository().getSnapshot())).not.toContain(created.view_token!);
		const listed = (await discover(first)).find((post) => post.id === created.id)!;
		expect(listed.view_count).toBe(0);
		expect(verifyFeedViewTicket(userId(first), postId, listed.view_token!, Date.now())).toBe(true);
	});

	it('counts a view within one buffer flush and shows it in the next response', async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const postId = await publicPost(author);

		await sendViews(viewer, [await seenBy(viewer, postId)])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await flushViews();

		expect(await storedViews(postId)).toBe(1);
		expect((await getPost(viewer, postId)).view_count).toBe(1);
		expect((await getPost(author, postId)).view_count).toBe(1);
	});

	it('the same user adds at most one view per post in 60 s, and one more after the minute', async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const postId = await publicPost(author);
		const view = await seenBy(viewer, postId);
		const start = Date.now();
		vi.useFakeTimers({toFake: ['Date'], now: start});

		await sendViews(viewer, [view, view]).expect(HTTP_STATUS.NO_CONTENT).execute();
		vi.setSystemTime(start + 59_000);
		const refused = await sendViews(viewer, [view]).executeRaw();
		expect(refused.response.status).toBe(HTTP_TOO_MANY_REQUESTS);
		expect(refused.json).toMatchObject({code: APIErrorCodes.RATE_LIMITED, retry_after: 1});
		await flushViews();
		expect(await storedViews(postId)).toBe(1);

		vi.setSystemTime(start + 60_000);
		await sendViews(viewer, [view]).expect(HTTP_STATUS.NO_CONTENT).execute();
		await flushViews();
		expect(await storedViews(postId)).toBe(2);
	});

	it('a RATE_LIMIT_BYPASS account is held to one batch a minute by the gate while rate limits are on', async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		await addFlag(viewer, UserFlags.RATE_LIMIT_BYPASS);
		const postId = await publicPost(author);
		const view = await seenBy(viewer, postId);
		const limited = () => sendViews(viewer, [view]).header(RATE_LIMITS_ON, 'true');

		await limited().expect(HTTP_STATUS.NO_CONTENT).execute();
		// Seven batches: without the flag the seventh is the bucket's (6 a minute), with its header.
		for (let batch = 2; batch <= 7; batch++) {
			const refused = await limited().executeRaw();
			expect(refused.response.status, `batch ${batch}`).toBe(HTTP_TOO_MANY_REQUESTS);
			expect(refused.json).toMatchObject({code: APIErrorCodes.RATE_LIMITED, global: false});
			expect(refused.response.headers.get('X-RateLimit-Bucket'), `batch ${batch}`).toBeNull();
		}
		await flushViews();
		expect(await storedViews(postId)).toBe(1);
	});

	it("counts nothing for another viewer's, a forged or an expired ticket and still answers 204", async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const [owner, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
		const [a, b, c] = [await publicPost(author), await publicPost(author), await publicPost(author)];
		const expired = signFeedViewTicket(userId(viewer), BigInt(c), Date.now() - 13 * HOUR);

		await sendViews(viewer, [await seenBy(owner, a)])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await sendViews(viewer, [{id: b, token: `${Math.floor(Date.now() / 1000) + 3600}.AAAAAAAAAAAAAAAAAAAAAA`}])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await sendViews(viewer, [{id: c, token: expired}])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await flushViews();

		for (const postId of [a, b, c]) expect(await storedViews(postId)).toBe(0);
		// None of them closed the viewer's minute.
		await sendViews(viewer, [await seenBy(viewer, a)])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await flushViews();
		expect(await storedViews(a)).toBe(1);
	});

	it('refuses a batch over 100 with 400', async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const view = await seenBy(viewer, await publicPost(author));

		await sendViews(
			viewer,
			Array.from({length: 101}, () => view),
		)
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		await sendViews(viewer, [{id: view.id, token: 'x'.repeat(65)}])
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		await flushViews();
		expect(await storedViews(view.id)).toBe(0);
	});

	it("counts the author's own view", async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const created = await createPost(harness, author, {content: 'kendi'}).execute();

		await sendViews(author, [viewOf(created)])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await flushViews();

		expect(await storedViews(created.id)).toBe(1);
	});

	it("a view does not touch the post's Keşfet trend counter", async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const postId = await publicPost(author);
		const trend = await getKVCounterService().get(FEED_TREND_COUNTER, postId);

		await sendViews(viewer, [await seenBy(viewer, postId)])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await flushViews();

		expect(await storedViews(postId)).toBe(1);
		expect(await getKVCounterService().get(FEED_TREND_COUNTER, postId)).toBe(trend);
	});

	it('a Discover entry without view_count shows no count but still gets a ticket', async () => {
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const postId = await publicPost(author);
		// Built while view counts were off, as by an image without them.
		await discoverWith(postId);
		viewsOn();

		const listed = (await discover(viewer)).find((post) => post.id === postId)!;

		expect(listed).not.toHaveProperty('view_count');
		expect(verifyFeedViewTicket(userId(viewer), BigInt(postId), listed.view_token!, Date.now())).toBe(true);
	});

	it('a Discover snapshot built while views were on shows no view_count once they are off', async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const postId = await publicPost(author);
		await discoverWith(postId);
		const entry = (await getFeedDiscoverRepository().getSnapshot())!.entries.find((item) => item.post.id === postId)!;
		expect(entry.post).toHaveProperty('view_count', 0);
		// Views off again: the limit override goes.
		vi.mocked(getLimitConfigService().getConfigSnapshot).mockRestore();

		const listed = (await discover(viewer)).find((post) => post.id === postId)!;

		expect(listed).not.toHaveProperty('view_count');
		expect(listed).not.toHaveProperty('view_token');
	});

	it('the content filter finds no text to check in a view batch', () => {
		const ticket = signFeedViewTicket(createUserID(1n), 2n, Date.now());

		expect(extractStringValues({views: [{id: '2', token: ticket}]})).toEqual([]);
	});

	it('declares its own rate limit bucket on the view route', () => {
		const app = new Hono<HonoEnv>();
		FeedViewController(app);
		const limiter = String(RateLimitMiddleware(RateLimitConfigs.FEED_VIEWS));

		const views = app.routes.filter((route) => route.method === 'POST' && route.path === '/feed/views');
		expect(views.length).toBeGreaterThan(0);
		expect(views.some((route) => String(route.handler) === limiter)).toBe(true);
	});

	it('stays outside the global limit so the session survives, and its own bucket answers the seventh batch in a minute', async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const view = await seenBy(viewer, await publicPost(author));
		const limited = () => sendViews(viewer, [view]).header(RATE_LIMITS_ON, 'true').header(GLOBAL_LIMIT, '1');

		await limited().expect(HTTP_STATUS.NO_CONTENT).execute();
		for (let batch = 2; batch <= 6; batch++) {
			const gated = await limited().executeRaw();
			expect(gated.response.status, `batch ${batch}`).toBe(HTTP_TOO_MANY_REQUESTS);
			expect(gated.response.headers.get('X-RateLimit-Bucket')).toBeNull();
		}
		const bucketed = await limited().executeRaw();

		expect(bucketed.response.status).toBe(HTTP_TOO_MANY_REQUESTS);
		expect(bucketed.json).toMatchObject({code: APIErrorCodes.RATE_LIMITED, global: false});
		expect(bucketed.response.headers.get('X-RateLimit-Bucket')).toBe(
			createHash('sha256').update('feed:views').digest('hex').slice(0, 16),
		);
		await getHome(harness, viewer).expect(HTTP_STATUS.OK).execute();
	});

	// The last two: this one shuts the service singletons down, the next needs them shut.
	it('shutdownServiceSingletons writes the buffered views before it returns', async () => {
		viewsOn();
		const author = await createTestAccount(harness);
		const viewer = await createTestAccount(harness);
		const postId = await publicPost(author);
		await sendViews(viewer, [await seenBy(viewer, postId)])
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		await shutdownServiceSingletons();

		expect(await storedViews(postId)).toBe(1);
		resetServiceSingletonsForTesting();
	});

	// No initialization owns the singletons now, as in a unit test that resets them: the limit config service is known
	// only through the variable resetServiceSingletonsForTesting clears straight after starting the shutdown.
	it('resetServiceSingletonsForTesting still shuts the limit config service down while a view service is up', async () => {
		const stop = vi.spyOn(getLimitConfigService(), 'shutdown');
		getFeedViewService();

		resetServiceSingletonsForTesting();

		await vi.waitFor(() => expect(stop).toHaveBeenCalled());
	});
});
