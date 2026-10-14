// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {blockUser, createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import {type FeedMedia, FeedPostFlags, type FeedPostRow} from '@app/api/database/types/FeedTypes';
import {feedDiscoverCache} from '@app/api/feed/discover/FeedDiscoverCache';
import {FeedDiscoverRepository} from '@app/api/feed/discover/FeedDiscoverRepository';
import type {TrendAccount} from '@app/api/feed/discover/FeedDiscoverRules';
import {createPost, overrideLimits, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {Logger} from '@app/api/Logger';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedDiscoverRepository,
	getFeedRepository,
	getFeedTimelineService,
	getFeedTrendService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {onUserBanned} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {FeedCommentListResponse, FeedPostListResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import type {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const IMAGE: FeedMedia = {
	attachment_id: 1n,
	filename: 'a.png',
	size: 10n,
	description: null,
	width: 10,
	height: 10,
	content_type: 'image/png',
	content_hash: null,
	placeholder: null,
	flags: 0,
	nsfw: false,
};

let sequence = 0;
// An eligible reporter three days old; worker 7 keeps its ID apart from the ones the services generate.
const oldAccount = (): TrendAccount => ({
	id: createUserID(createSnowflake({timestamp: Date.now() - 100 * HOUR, workerId: 7, sequence: sequence++ % 4096})),
	email: 'discover@example.com',
	emailVerified: true,
	hasVerifiedPhone: false,
	flags: 0n,
	suspiciousActivityFlags: 0,
	isBot: false,
	isSystem: false,
	isUnclaimedAccount: () => false,
});

describe('Keşfet list, snapshot cache and GET /feed/discover', () => {
	let harness: ApiTestHarness;
	let kv: MockKVProvider;
	const repository = () => getFeedDiscoverRepository();

	// Test accounts are brand new, so the list is built a day ahead (authors >= 24 h, posts still inside 72 h). The 20 s
	// build gate is cleared first so it does not carry over from the previous build.
	async function build(now = Date.now() + 25 * HOUR): Promise<number> {
		await getKVClient().del('feed:discover:build');
		return getFeedTimelineService().discover.buildSnapshot(now);
	}
	// A fresh process: shut the old subscription down first, or initialize would find it still stopping.
	async function restartCache(): Promise<void> {
		await feedDiscoverCache.shutdown();
		feedDiscoverCache.resetForTesting();
		feedDiscoverCache.setRefreshSubscriber(getKVClient());
		await feedDiscoverCache.initialize();
	}
	// Rewrites the stored snapshot as one built at `version` (a real build runs a day ahead, see build()).
	async function restamp(version: number): Promise<void> {
		const snapshot = (await repository().getSnapshot())!;
		await repository().putSnapshot({...snapshot, version});
	}
	const snapshotIds = async () => (await repository().getSnapshot())?.entries.map((entry) => entry.post.id) ?? [];
	const cachedIds = () => feedDiscoverCache.current().entries.map((entry) => entry.post.id);
	const ranked = () => kv.zrangebyscore('feed:discover:z', '-inf', '+inf');
	const discover = (viewer: TestAccount, query = '') =>
		createBuilder<FeedPostListResponse>(harness, viewer.token).get(`/feed/discover${query}`);
	const discoverIds = async (viewer: TestAccount) => (await discover(viewer).execute()).map((post) => post.id);
	const comments = (viewer: TestAccount, postId: string, query = '') =>
		createBuilder<FeedCommentListResponse>(harness, viewer.token).get(`/feed/posts/${postId}/comments${query}`);
	const comment = (author: TestAccount, postId: string, content: string) =>
		createBuilder(harness, author.token).post(`/feed/posts/${postId}/comments`).body({content}).execute();
	// Test accounts are brand new: a stranger that new may not comment on a public post, a friend of its author may.
	async function befriendAuthor(author: TestAccount, commenters: Array<TestAccount>): Promise<void> {
		for (const commenter of commenters) await createFriendship(harness, author, commenter);
	}
	const deletePost = (author: TestAccount, postId: string) =>
		createBuilder(harness, author.token).delete(`/feed/posts/${postId}`).expect(HTTP_STATUS.NO_CONTENT).execute();

	// A public post through the API (written while the author is public), placed in the ranking with `score`
	// (higher comes first).
	async function publish(author: TestAccount, score: number): Promise<string> {
		await setProfileLevel(author, 100);
		const post = await createPost(harness, author, {content: `puan ${score}`}).execute();
		await repository().rankPost(BigInt(post.id), score);
		return post.id;
	}
	// A post row written straight to the repository (no daily or burst limit), placed in the ranking; its author is
	// public.
	async function plant(author: TestAccount, score: number, patch: Partial<FeedPostRow> = {}): Promise<string> {
		await setProfileLevel(author, 100);
		const row: FeedPostRow = {
			post_id: await getSnowflakeService().generate(),
			author_id: createUserID(BigInt(author.userId)),
			content: `puan ${score}`,
			media: null,
			edited_at: null,
			flags: FeedPostFlags.PUBLIC,
			like_count: 0,
			comment_count: 0,
			...patch,
		};
		await getFeedRepository().createPost(row);
		await repository().rankPost(row.post_id, score);
		return row.post_id.toString();
	}
	async function addFlag(account: TestAccount, flag: bigint): Promise<void> {
		const id = createUserID(BigInt(account.userId));
		const user = (await getUserRepository().findUnique(id))!;
		await getUserRepository().patchUpsert(id, {flags: user.flags | flag}, user.toRow());
	}
	const accounts = async (count: number) => Promise.all(Array.from({length: count}, () => createTestAccount(harness)));

	beforeAll(async () => {
		harness = await createApiTestHarness();
		kv = harness.kvProvider as MockKVProvider;
	});
	beforeEach(async () => {
		await harness.reset();
		await restartCache();
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await feedDiscoverCache.shutdown();
		await harness?.shutdown();
	});

	it('shows public posts of strangers in score order to a new account that follows nobody', async () => {
		const [a, b, viewer] = await accounts(3);
		const low = await publish(a!, 5);
		const high = await publish(b!, 10);
		const lowest = await publish(b!, 1);
		const info = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'info');
		expect(await build()).toBe(3);
		// How many authors fill the list: a ring pushing a few accounts up shows as few authors.
		expect(info).toHaveBeenCalledWith(expect.objectContaining({authors: 2}), 'Built the Keşfet snapshot');
		await feedDiscoverCache.refresh();

		const page = await discover(viewer!).execute();
		expect(page.map((post) => post.id)).toEqual([high, low, lowest]);
		expect(page[0]).toMatchObject({public: true, liked: false, author: {id: b!.userId}});
	});

	it('a non-public post planted in the ranking never reaches the snapshot and leaves the ranking', async () => {
		const [author, viewer] = await accounts(2);
		await setProfileLevel(author!, 0);
		const hidden = (await createPost(harness, author!, {content: 'gizli'}).execute()).id;
		await repository().rankPost(BigInt(hidden), 100);
		const shown = await publish(author!, 1);
		await build();
		await feedDiscoverCache.refresh();

		expect(await snapshotIds()).toEqual([shown]);
		expect(await ranked()).not.toContain(hidden);
		expect(await discoverIds(viewer!)).toEqual([shown]);
	});

	it("leaves out hidden, deleted, spammer, disabled and too-new authors' posts", async () => {
		const [ok, deleted, disabled, spammer] = await accounts(4);
		const shown = await plant(ok!, 1);
		const reported = await plant(ok!, 2);
		await repository().hidePost(BigInt(reported));
		await plant(deleted!, 3);
		await plant(disabled!, 4);
		await plant(spammer!, 5);
		await addFlag(deleted!, UserFlags.DELETED);
		await addFlag(disabled!, UserFlags.DISABLED);
		await addFlag(spammer!, UserFlags.SPAMMER);

		await build();
		expect(await snapshotIds()).toEqual([shown]);
		expect(await ranked()).toEqual([shown]);

		// Today the author is a few seconds old: not in the list, but still ranked for when they are old enough.
		expect(await build(Date.now())).toBe(0);
		expect(await ranked()).toEqual([shown]);
	});

	it('a post with images stays out of Keşfet while feature_feed_discover_media is 0 and enters when it is 1', async () => {
		const [author] = await accounts(1);
		const withImage = await plant(author!, 3, {media: [IMAGE]});
		const text = await plant(author!, 2);
		const poll = await plant(author!, 1, {
			poll_options: ['evet', 'hayır'],
			poll_expires_at: new Date(Date.now() + HOUR),
		});

		await build();
		expect(await snapshotIds()).toEqual([text, poll]);
		expect(await ranked()).toContain(withImage);

		overrideLimits({feature_feed_discover_media: 1});
		await build();
		expect(await snapshotIds()).toEqual([withImage, text, poll]);
	});

	it('leaves out posts reported by three eligible people', async () => {
		const [author, viewer] = await accounts(2);
		const reported = await publish(author!, 10);
		const other = await publish(author!, 5);
		const row = (await getFeedRepository().getPost(BigInt(reported)))!;
		for (let index = 0; index < 3; index++) await getFeedTrendService().recordReport(oldAccount(), row);
		// Even ranked again (a late counter flush), the hidden flag keeps it out.
		await repository().rankPost(BigInt(reported), 100);

		await build();
		await feedDiscoverCache.refresh();
		expect(await discoverIds(viewer!)).toEqual([other]);
	});

	it('blocking an author drops them from the very next discover page', async () => {
		const [blocked, blocker, viewer] = await accounts(3);
		const fromBlocked = await publish(blocked!, 10);
		const fromBlocker = await publish(blocker!, 5);
		await build();
		await feedDiscoverCache.refresh();
		expect(await discoverIds(viewer!)).toEqual([fromBlocked, fromBlocker]);

		await blockUser(harness, viewer!, blocked!.userId);
		await blockUser(harness, blocker!, viewer!.userId);
		// A page that computed the viewer's set just before the blocks cannot write it back over the hook's mark.
		await repository().putBlockSet(createUserID(BigInt(viewer!.userId)), {ids: new Set(), overflow: false});
		expect(await discoverIds(viewer!)).toEqual([]);
	});

	it('a permanent ban takes the author out of every API cache at once', async () => {
		const [banned, other, viewer] = await accounts(3);
		await publish(banned!, 10);
		const kept = await publish(other!, 5);
		await build();
		await feedDiscoverCache.refresh();

		await onUserBanned({userId: createUserID(BigInt(banned!.userId))});
		expect(await discoverIds(viewer!)).toEqual([kept]);
	});

	it('a new hiding flag (timed ban, spammer) takes the author out of every API cache at once', async () => {
		const [banned, spammer, other, viewer] = await accounts(4);
		await publish(banned!, 10);
		await publish(spammer!, 9);
		const kept = await publish(other!, 5);
		await build();
		await feedDiscoverCache.refresh();

		await addFlag(banned!, UserFlags.DISABLED);
		await addFlag(spammer!, UserFlags.SPAMMER);
		expect(await discoverIds(viewer!)).toEqual([kept]);

		// A write that adds no hiding flag broadcasts nothing.
		kv.publishSpy.mockClear();
		await addFlag(banned!, UserFlags.DISABLED);
		expect(kv.publishSpy).not.toHaveBeenCalledWith('feed:discover:refresh', expect.anything());
	});

	it('pages with X-Next-Cursor and ends without it', async () => {
		const [author, viewer] = await accounts(2);
		const ids: Array<string> = [];
		for (let score = 25; score > 0; score--) ids.push(await plant(author!, score));
		await build();
		await feedDiscoverCache.refresh();

		const first = await discover(viewer!, '?limit=10').executeWithResponse();
		const firstCursor = first.response.headers.get('X-Next-Cursor');
		expect(first.json.map((post) => post.id)).toEqual(ids.slice(0, 10));
		expect(firstCursor).toMatch(/^\d+\.10$/);
		const second = await discover(viewer!, `?limit=10&cursor=${firstCursor}`).executeWithResponse();
		expect(second.json.map((post) => post.id)).toEqual(ids.slice(10, 20));
		const third = await discover(
			viewer!,
			`?limit=10&cursor=${second.response.headers.get('X-Next-Cursor')}`,
		).executeWithResponse();
		expect(third.json.map((post) => post.id)).toEqual(ids.slice(20));
		expect(third.response.headers.get('X-Next-Cursor')).toBeNull();
	});

	it("Keşfet counts come from the snapshot while the viewer's own like shows at once", async () => {
		const [author, viewer] = await accounts(2);
		const postId = await publish(author!, 1);
		await build();
		await feedDiscoverCache.refresh();
		await createBuilder(harness, viewer!.token)
			.put(`/feed/posts/${postId}/like`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(
			(await createBuilder<{like_count: number}>(harness, viewer!.token).get(`/feed/posts/${postId}`).execute())
				.like_count,
		).toBe(1);

		kv.mgetSpy.mockClear();
		const [shown] = await discover(viewer!).execute();
		expect(shown).toMatchObject({id: postId, like_count: 0, liked: true});
		const keys = (kv.mgetSpy.mock.calls as Array<Array<string>>).flat();
		expect(keys.filter((key) => key.startsWith('counter:'))).toEqual([]);
	});

	it('drops a deleted post from every API cache at once and does not bring it back on the next refresh', async () => {
		const [author, viewer] = await accounts(2);
		const deleted = await publish(author!, 10);
		const kept = await publish(author!, 5);
		await build();
		await feedDiscoverCache.refresh();
		kv.publishSpy.mockClear();

		await deletePost(author!, deleted);
		expect(kv.publishSpy).toHaveBeenCalledWith('feed:discover:refresh', `post:${deleted}`);
		expect(await discoverIds(viewer!)).toEqual([kept]);
		await feedDiscoverCache.refresh();
		expect(await discoverIds(viewer!)).toEqual([kept]);
	});

	it('a process that starts after the eviction does not serve the post', async () => {
		const [author, viewer] = await accounts(2);
		const deleted = await publish(author!, 10);
		const kept = await publish(author!, 5);
		await build();
		await deletePost(author!, deleted);

		await restartCache();
		expect(await discoverIds(viewer!)).toEqual([kept]);
	});

	it('keeps serving the last snapshot when the snapshot key is gone', async () => {
		const [author, viewer] = await accounts(2);
		const ids = [await publish(author!, 2), await publish(author!, 1)];
		await build();
		await feedDiscoverCache.refresh();
		expect(await discoverIds(viewer!)).toEqual(ids);

		await getKVClient().del('feed:discover:snapshot');
		await feedDiscoverCache.refresh();
		expect(await discoverIds(viewer!)).toEqual(ids);
	});

	it('fills the list from deeper in the ranking when the top is ineligible and drops dead entries from it', async () => {
		const [author] = await accounts(1);
		for (let index = 0; index < 1500; index++) await plant(author!, 10_000 + index, {flags: 0});
		const eligible: Array<string> = [];
		for (let score = 10; score > 0; score--) eligible.push(await plant(author!, score));
		expect(await kv.zcard('feed:discover:z')).toBe(1510);

		expect(await build()).toBe(10);
		expect(await snapshotIds()).toEqual(eligible);
		expect(await kv.zcard('feed:discover:z')).toBe(10);
	});

	it('a stranger does not see comments from people who block them on a public post', async () => {
		const [author, blocker, friendly, viewer] = await accounts(4);
		await befriendAuthor(author!, [friendly!, blocker!]);
		const postId = await publish(author!, 1);
		await comment(friendly!, postId, 'merhaba');
		await comment(blocker!, postId, 'görme beni');
		await blockUser(harness, blocker!, viewer!.userId);

		expect((await comments(viewer!, postId).execute()).map((entry) => entry.author.id)).toEqual([friendly!.userId]);
		expect((await comments(author!, postId).execute()).map((entry) => entry.author.id)).toEqual([
			blocker!.userId,
			friendly!.userId,
		]);
	});

	it('answers 403 when feature_feed_discover is 0 and builds an empty list', async () => {
		const [author, viewer] = await accounts(2);
		await publish(author!, 1);
		overrideLimits({feature_feed_discover: 0});

		await discover(viewer!).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
		expect(await build()).toBe(0);
		expect(await snapshotIds()).toEqual([]);
	});

	it('a second build within 20 seconds does nothing', async () => {
		const [author] = await accounts(1);
		await publish(author!, 1);
		const now = Date.now() + 25 * HOUR;
		expect(await build(now)).toBe(1);
		expect(await getFeedTimelineService().discover.buildSnapshot(now + 1000)).toBe(-1);
	});

	it('a build that lost its gate to a later build writes nothing and prunes nothing', async () => {
		const [author] = await accounts(1);
		await plant(author!, 1);
		await getKVClient().del('feed:discover:build');
		const later = {version: Date.now() + 26 * HOUR, entries: []};
		const listRanked = repository().listRanked.bind(repository());
		vi.spyOn(repository(), 'listRanked').mockImplementationOnce(async (offset, limit) => {
			// This build ran past its 20 s: a later one took the gate and stored a newer snapshot.
			await getKVClient().del('feed:discover:build');
			await getKVClient().set('feed:discover:build', 'later-build');
			await repository().putSnapshot(later);
			return listRanked(offset, limit);
		});
		await repository().publishEvict('post', '42', Date.now());

		expect(await getFeedTimelineService().discover.buildSnapshot(Date.now() + 25 * HOUR)).toBe(-1);
		expect((await repository().getSnapshot())?.version).toBe(later.version);
		expect(await kv.zrangebyscore('feed:discover:evicted', '-inf', '+inf')).toContain('post:42');
	});

	it('keeps the snapshot within 2 MB: entries past the budget are left out and counted in the build log', async () => {
		const authors = await accounts(4);
		const big = 'x'.repeat(800_000);
		const first = await plant(authors[0]!, 4, {content: big});
		const second = await plant(authors[1]!, 3, {content: big});
		await plant(authors[2]!, 2, {content: big});
		const small = await plant(authors[3]!, 1);
		const info = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'info');

		expect(await build()).toBe(3);
		expect(await snapshotIds()).toEqual([first, second, small]);
		expect(Buffer.byteLength(JSON.stringify(await repository().getSnapshot()))).toBeLessThanOrEqual(2 * 1024 * 1024);
		expect(info).toHaveBeenCalledWith(expect.objectContaining({over_budget: 1}), 'Built the Keşfet snapshot');
	});

	it('a late build never brings an evicted post back', async () => {
		const [author] = await accounts(1);
		const deleted = await publish(author!, 10);
		const kept = await publish(author!, 5);
		await build();
		// The last snapshot the cron wrote, a moment ago; the cron then stalls.
		await restamp(Date.now());
		await feedDiscoverCache.refresh();
		await deletePost(author!, deleted);
		expect(cachedIds()).toEqual([kept]);

		// Five minutes on the in-memory eviction is forgotten and the same old snapshot is read again.
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * MINUTE);
		await feedDiscoverCache.refresh();
		expect(cachedIds()).toEqual([kept]);
	});

	it('does not adopt an old snapshot while recent evictions cannot be read', async () => {
		const [author] = await accounts(1);
		const first = await publish(author!, 1);
		await build();
		await restamp(Date.now() - 10 * MINUTE);
		await feedDiscoverCache.refresh();
		const second = await publish(author!, 5);
		await build();
		await restamp(Date.now() - 3 * MINUTE);
		vi.spyOn(FeedDiscoverRepository.prototype, 'listEvictionsSince').mockRejectedValue(new Error('kv down'));

		await feedDiscoverCache.refresh();
		expect(cachedIds()).toEqual([first]);
		await restamp(Date.now() - MINUTE);
		await feedDiscoverCache.refresh();
		expect(cachedIds()).toEqual([second, first]);
	});

	it('a failing first snapshot read does not stop the API from starting', async () => {
		await feedDiscoverCache.shutdown();
		feedDiscoverCache.resetForTesting();
		feedDiscoverCache.setRefreshSubscriber(getKVClient());
		vi.spyOn(FeedDiscoverRepository.prototype, 'getSnapshot').mockRejectedValue(new Error('kv down'));
		const warn = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');

		await expect(feedDiscoverCache.initialize()).resolves.toBeUndefined();
		expect(feedDiscoverCache.current().entries).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({error: expect.any(Error)}),
			'Reading the Keşfet snapshot failed; keeping the last one',
		);
	});

	it("fills a stranger's comment page from up to three pages when blocked commenters are filtered out", async () => {
		const [author, friendly, viewer, ...blockers] = await accounts(6);
		await befriendAuthor(author!, [friendly!, ...blockers]);
		for (const blocker of blockers) await blockUser(harness, blocker, viewer!.userId);
		const commenterIds = async (postId: string) =>
			(await comments(viewer!, postId, '?limit=2').execute()).map((entry) => entry.author.id);

		const nearby = await publish(author!, 2);
		await comment(friendly!, nearby, 'eski yorum');
		await comment(blockers[0]!, nearby, 'yeni 1');
		await comment(blockers[1]!, nearby, 'yeni 2');
		expect(await commenterIds(nearby)).toEqual([friendly!.userId]);

		// Three full pages of blocked commenters above it: the fourth page is not read.
		const deep = await publish(author!, 1);
		await comment(friendly!, deep, 'en eski');
		for (let index = 0; index < 7; index++) await comment(blockers[index % 3]!, deep, `yeni ${index}`);
		expect(await commenterIds(deep)).toEqual([]);
		expect((await comments(author!, deep, '?limit=8').execute()).at(-1)!.author.id).toBe(friendly!.userId);
	});

	it('works for 1000 posts from 3 authors without losing any', async () => {
		const authors = await accounts(3);
		const ids = new Set<string>();
		for (let index = 0; index < 1000; index++) ids.add(await plant(authors[index % 3]!, 1000 - index));

		expect(await build()).toBe(1000);
		const stored = await snapshotIds();
		expect(stored).toHaveLength(1000);
		expect(new Set(stored)).toEqual(ids);
	});
});
