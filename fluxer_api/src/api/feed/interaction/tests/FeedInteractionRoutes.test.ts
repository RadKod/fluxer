// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {blockUser, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FeedPosts} from '@app/api/feed/FeedTables';
import {createPost, getHome, overrideLimits, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {contentModerationService} from '@app/api/infrastructure/ContentModerationService';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedInteractionRepository,
	getFeedInteractionService,
	getFeedRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {UserAccountLookupService} from '@app/api/user/services/UserAccountLookupService';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {
	FeedCommentListResponse,
	FeedCommentResponse,
	FeedPostListResponse,
	FeedPostResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {createSnowflakeFromTimestamp} from '@fluxer/snowflake/src/Snowflake';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const DAY_MS = 86_400_000;
const FETCH_POST_ROW_CQL = FeedPosts.selectCql({where: FeedPosts.where.eq('post_id'), limit: 1});

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

// The row as Cassandra holds it, including a partial row without author_id that the feed's own reads ignore.
async function storedPostRow(postId: string): Promise<FeedPostRow | null> {
	return fetchOne<FeedPostRow>(FETCH_POST_ROW_CQL, {post_id: BigInt(postId)});
}

const ids = (entries: ReadonlyArray<{id: string}>) => entries.map((entry) => entry.id);

describe('feed likes and comments', () => {
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

	const like = (account: TestAccount, postId: string) =>
		createBuilder(harness, account.token).put(`/feed/posts/${postId}/like`);
	const unlike = (account: TestAccount, postId: string) =>
		createBuilder(harness, account.token).delete(`/feed/posts/${postId}/like`);
	const likers = (account: TestAccount, postId: string, query = '') =>
		createBuilder<Array<UserPartialResponse>>(harness, account.token).get(`/feed/posts/${postId}/likes${query}`);
	const getPost = (account: TestAccount, postId: string) =>
		createBuilder<FeedPostResponse>(harness, account.token).get(`/feed/posts/${postId}`);
	const comment = (account: TestAccount, postId: string, content: string) =>
		createBuilder<FeedCommentResponse>(harness, account.token).post(`/feed/posts/${postId}/comments`).body({content});
	const comments = (account: TestAccount, postId: string, query = '') =>
		createBuilder<FeedCommentListResponse>(harness, account.token).get(`/feed/posts/${postId}/comments${query}`);
	const deleteComment = (account: TestAccount, postId: string, commentId: string) =>
		createBuilder(harness, account.token).delete(`/feed/posts/${postId}/comments/${commentId}`);

	it('counts one like per account and shows like_count and liked on every post response', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const post = await createPost(harness, alice, {content: 'beğen'}).execute();

		await Promise.all(Array.from({length: 10}, () => like(bob, post.id).expect(HTTP_STATUS.NO_CONTENT).execute()));
		await like(carol, post.id).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await getPost(bob, post.id).execute()).toMatchObject({like_count: 2, liked: true});
		expect(await getPost(alice, post.id).execute()).toMatchObject({like_count: 2, liked: false});
		expect((await getHome(harness, alice).execute())[0]).toMatchObject({id: post.id, like_count: 2, liked: false});
		const profile = await createBuilder<FeedPostListResponse>(harness, bob.token)
			.get(`/users/${alice.userId}/posts`)
			.execute();
		expect(profile[0]).toMatchObject({id: post.id, like_count: 2, liked: true});

		const sorted = [bob.userId, carol.userId].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
		expect(ids(await likers(alice, post.id).execute())).toEqual(sorted);
		const first = await likers(alice, post.id, '?limit=1').execute();
		expect(ids(first)).toEqual([sorted[0]]);
		expect(ids(await likers(alice, post.id, `?after=${first[0]!.id}`).execute())).toEqual([sorted[1]]);

		await Promise.all([
			unlike(bob, post.id).expect(HTTP_STATUS.NO_CONTENT).execute(),
			unlike(bob, post.id).expect(HTTP_STATUS.NO_CONTENT).execute(),
		]);
		expect(await getPost(bob, post.id).execute()).toMatchObject({like_count: 1, liked: false});
		expect(ids(await likers(alice, post.id).execute())).toEqual([carol.userId]);

		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toMatchObject({like_count: 1, comment_count: 0});
	});

	it('checks access to a post without building the full profile of its author', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'hafif erişim'}).execute();
		const fullProfile = vi.spyOn(UserAccountLookupService.prototype, 'getUserProfile');

		await like(bob, post.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		await getPost(bob, post.id).execute();
		await comment(bob, post.id, 'selam').execute();

		expect(fullProfile).not.toHaveBeenCalled();
	});

	it('adds, pages and deletes comments; only the comment author and the post author may delete', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const post = await createPost(harness, alice, {content: 'yorumla'}).execute();
		const scanText = vi.spyOn(contentModerationService, 'scanText');

		const first = await comment(bob, post.id, 'bir').execute();
		expect(first).toMatchObject({post_id: post.id, content: 'bir', edited_at: null});
		expect(first.author.id).toBe(bob.userId);
		expect(scanText).toHaveBeenCalledWith('bir', expect.objectContaining({surface: 'message_content'}));
		const second = await comment(carol, post.id, 'iki').execute();
		const third = await comment(bob, post.id, 'üç').execute();

		expect(ids(await comments(alice, post.id).execute())).toEqual([third.id, second.id, first.id]);
		expect(ids(await comments(alice, post.id, `?before=${third.id}&limit=1`).execute())).toEqual([second.id]);
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 3});

		await deleteComment(carol, post.id, first.id)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_PERMISSIONS)
			.execute();
		await deleteComment(bob, post.id, first.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		await deleteComment(alice, post.id, second.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		await deleteComment(bob, post.id, first.id)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();

		expect(ids(await comments(alice, post.id).execute())).toEqual([third.id]);
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 1});
		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toMatchObject({comment_count: 1});
	});

	it('pages comments across ten day buckets without gaps or repeats', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'eski yorumlar'}).execute();
		const postRow = (await getFeedRepository().getPost(BigInt(post.id)))!;
		const user = (await getUserRepository().findUnique(createUserID(BigInt(alice.userId))))!;
		const now = Date.now();
		const snowflakes = vi.spyOn(getSnowflakeService(), 'generate');
		for (const ageDays of [35, 34, 21, 2]) {
			snowflakes.mockResolvedValueOnce(createSnowflakeFromTimestamp(now - ageDays * DAY_MS));
		}
		const created: Array<string> = [];
		for (let index = 0; index < 4; index++) {
			const entry = await getFeedInteractionService().createComment(
				{user, post: postRow, content: `yorum ${index}`},
				createRequestCache(),
			);
			created.unshift(entry.id);
		}

		const seen: Array<string> = [];
		let query = '?limit=1';
		for (;;) {
			const page = await comments(alice, post.id, query).execute();
			if (page.length === 0) break;
			seen.push(...ids(page));
			query = `?limit=1&before=${page.at(-1)!.id}`;
		}
		expect(seen).toEqual(created);
		expect(ids(await comments(alice, post.id, '?limit=50').execute())).toEqual(created);
	});

	it('refuses likes and comments across a block with 404 and without profile access with 403', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const stranger = await createTestAccount(harness);
		await setProfileLevel(alice, 0); // a post not marked public
		const post = await createPost(harness, alice, {content: 'yalnız tanıdıklara'}).execute();
		const own = await comment(alice, post.id, 'ilk').execute();

		const refused = (account: TestAccount) => [
			like(account, post.id),
			unlike(account, post.id),
			likers(account, post.id),
			comment(account, post.id, 'merhaba'),
			comments(account, post.id),
		];
		for (const request of refused(stranger)) {
			await request.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		}

		await blockUser(harness, alice, bob.userId);
		await blockUser(harness, carol, alice.userId);
		for (const account of [bob, carol]) {
			for (const request of refused(account)) {
				await request.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST).execute();
			}
		}
		// The post author still reads its post and removes comments.
		await deleteComment(alice, post.id, own.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await getPost(alice, post.id).execute()).toMatchObject({like_count: 0, comment_count: 0});
	});

	it('answers 404 for a deleted post and flushes no counter into a ghost row', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'silinecek'}).execute();
		await like(bob, post.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		const entry = await comment(bob, post.id, 'geç kaldım').execute();

		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();

		for (const request of [
			like(bob, post.id),
			likers(bob, post.id),
			comment(bob, post.id, 'yine'),
			comments(bob, post.id),
			deleteComment(bob, post.id, entry.id),
		]) {
			await request.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST).execute();
		}
		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toBeNull();
		const interactions = getFeedInteractionRepository();
		expect(await interactions.getComment(BigInt(post.id), BigInt(entry.id))).toBeNull();
		expect(await interactions.listLikerIds(BigInt(post.id), {limit: 10})).toEqual([]);
	});

	it('writes the comment bucket list row once per bucket, not on every comment', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'çok yorum'}).execute();
		// The in-memory executor runs batch members through executeQuery too, so this sees every statement once.
		const statements = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeQuery');

		for (const text of ['bir', 'iki', 'üç']) {
			await comment(alice, post.id, text).execute();
		}

		const bucketWrites = statements.mock.calls.filter(([query]) =>
			/^(INSERT INTO|UPDATE) feed_comment_buckets\s/.test(query.cql),
		);
		expect(bucketWrites).toHaveLength(1);
		expect(await comments(alice, post.id).execute()).toHaveLength(3);
	});

	it('refuses comments past max_comments_per_post with 400 until one is deleted', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'sınırlı'}).execute();
		overrideLimits({max_comments_per_post: 2});

		const first = await comment(alice, post.id, 'bir').execute();
		await comment(alice, post.id, 'iki').execute();
		await comment(alice, post.id, 'üç').expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.MAX_FEED_COMMENTS).execute();
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 2});

		await deleteComment(alice, post.id, first.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		await comment(alice, post.id, 'üç').execute();
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 2});
	});

	it('answers 403 on every interaction route while feature_feed is 0', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'kapanmadan önce'}).execute();
		const entry = await comment(alice, post.id, 'yorum').execute();

		overrideLimits({feature_feed: 0});
		for (const request of [
			like(alice, post.id),
			unlike(alice, post.id),
			likers(alice, post.id),
			comment(alice, post.id, 'kapalı'),
			comments(alice, post.id),
			deleteComment(alice, post.id, entry.id),
		]) {
			await request.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
		}
	});

	it('deletes the likes and comments of a deleted account idempotently, fixes the counts and exports them', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const bobId = createUserID(BigInt(bob.userId));
		const post = await createPost(harness, alice, {content: 'hesap silinecek'}).execute();
		await like(bob, post.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		await like(alice, post.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		const first = await comment(bob, post.id, 'bir').execute();
		const second = await comment(bob, post.id, 'iki').execute();
		const kept = await comment(alice, post.id, 'kalır').execute();

		const feedExport = (await collectUserHarvestExtensions({userId: bobId})).find((entry) => entry.name === 'feed');
		expect(feedExport?.data).toMatchObject({
			posts: [],
			comments: [
				{id: second.id, post_id: post.id, content: 'iki'},
				{id: first.id, post_id: post.id, content: 'bir'},
			],
			likes: [{post_id: post.id}],
		});

		await runUserDeletionHook('feed', {userId: bobId});
		await runUserDeletionHook('feed', {userId: bobId});

		expect(await getPost(alice, post.id).execute()).toMatchObject({like_count: 1, comment_count: 1, liked: true});
		expect(ids(await likers(alice, post.id).execute())).toEqual([alice.userId]);
		expect(ids(await comments(alice, post.id).execute())).toEqual([kept.id]);
		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toMatchObject({like_count: 1, comment_count: 1});
		const afterDeletion = await collectUserHarvestExtensions({userId: bobId});
		expect(afterDeletion.find((entry) => entry.name === 'feed')?.data).toEqual({
			posts: [],
			comments: [],
			likes: [],
			notifications: [],
			notification_read_state: {last_read_at: null},
		});
	});
});
