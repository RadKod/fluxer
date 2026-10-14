// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {blockUser, createFriendship, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {fetchMany, fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {FeedCommentRow, FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FeedCommentReplies, FeedCommentReplyBuckets, FeedComments, FeedPosts} from '@app/api/feed/FeedTables';
import {
	FEED_COMMENT_COUNT_COUNTER,
	FEED_COMMENT_REPLY_COUNT_COUNTER,
} from '@app/api/feed/interaction/FeedInteractionCounters';
import {createPost, overrideLimits, setProfileLevel} from '@app/api/feed/tests/FeedTestUtils';
import {contentModerationService} from '@app/api/infrastructure/ContentModerationService';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedInteractionRepository,
	getFeedInteractionService,
	getFeedNotificationService,
	getFeedRepository,
	getKVCounterService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import rebuildCounter from '@app/api/worker/tasks/RebuildCounter';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UnknownFeedCommentError} from '@fluxer/errors/src/domains/content/UnknownFeedCommentError';
import type {
	FeedCommentListResponse,
	FeedCommentResponse,
	FeedPostResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {createSnowflakeFromTimestamp} from '@fluxer/snowflake/src/Snowflake';
import {makeBucket} from '@fluxer/snowflake/src/SnowflakeBuckets';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOO_MANY_REQUESTS = 429;

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

const FETCH_POST_ROW_CQL = FeedPosts.selectCql({where: FeedPosts.where.eq('post_id'), limit: 1});
const FETCH_COMMENT_ROW_CQL = FeedComments.selectCql({
	where: [FeedComments.where.eq('post_id'), FeedComments.where.eq('bucket'), FeedComments.where.eq('comment_id')],
	limit: 1,
});
const FETCH_POST_REPLIES_CQL = FeedCommentReplies.selectCql({
	columns: ['reply_id'],
	where: FeedCommentReplies.where.eq('post_id'),
});
const FETCH_POST_REPLY_BUCKETS_CQL = FeedCommentReplyBuckets.selectCql({
	where: FeedCommentReplyBuckets.where.eq('post_id'),
});

const ids = (entries: ReadonlyArray<{id: string}>) => entries.map((entry) => entry.id);

describe('feed comment replies', () => {
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

	const getPost = (account: TestAccount, postId: string) =>
		createBuilder<FeedPostResponse>(harness, account.token).get(`/feed/posts/${postId}`);
	const comment = (account: TestAccount, postId: string, content: string) =>
		createBuilder<FeedCommentResponse>(harness, account.token).post(`/feed/posts/${postId}/comments`).body({content});
	const comments = (account: TestAccount, postId: string, query = '') =>
		createBuilder<FeedCommentListResponse>(harness, account.token).get(`/feed/posts/${postId}/comments${query}`);
	const deleteComment = (account: TestAccount, postId: string, commentId: string) =>
		createBuilder(harness, account.token).delete(`/feed/posts/${postId}/comments/${commentId}`);
	const reply = (account: TestAccount, postId: string, commentId: string, content: string) =>
		createBuilder<FeedCommentResponse>(harness, account.token)
			.post(`/feed/posts/${postId}/comments/${commentId}/replies`)
			.body({content});
	const replies = (account: TestAccount, postId: string, commentId: string, query = '') =>
		createBuilder<FeedCommentListResponse>(harness, account.token).get(
			`/feed/posts/${postId}/comments/${commentId}/replies${query}`,
		);
	const deleteReply = (account: TestAccount, postId: string, commentId: string, replyId: string) =>
		createBuilder(harness, account.token).delete(`/feed/posts/${postId}/comments/${commentId}/replies/${replyId}`);

	async function storedPostRow(postId: string): Promise<FeedPostRow | null> {
		return fetchOne<FeedPostRow>(FETCH_POST_ROW_CQL, {post_id: BigInt(postId)});
	}

	async function storedCommentRow(postId: string, commentId: string): Promise<FeedCommentRow | null> {
		return fetchOne<FeedCommentRow>(FETCH_COMMENT_ROW_CQL, {
			post_id: BigInt(postId),
			bucket: makeBucket(BigInt(commentId)),
			comment_id: BigInt(commentId),
		});
	}

	async function replyCountOf(account: TestAccount, postId: string, commentId: string): Promise<number | undefined> {
		const page = await comments(account, postId, '?limit=50').execute();
		return page.find((entry) => entry.id === commentId)?.reply_count;
	}

	it('replies to a comment and lists replies newest first with before paging', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const post = await createPost(harness, alice, {content: 'yanıtla'}).execute();
		const top = await comment(bob, post.id, 'üst yorum').execute();
		expect(top).toMatchObject({parent_id: null, reply_count: 0});
		const scanText = vi.spyOn(contentModerationService, 'scanText');

		const first = await reply(carol, post.id, top.id, 'bir').execute();
		expect(first).toMatchObject({post_id: post.id, parent_id: top.id, content: 'bir', edited_at: null});
		expect(first.author.id).toBe(carol.userId);
		expect(scanText).toHaveBeenCalledWith('bir', expect.objectContaining({surface: 'message_content'}));
		const second = await reply(alice, post.id, top.id, 'iki').execute();
		const third = await reply(bob, post.id, top.id, '@carol üç').execute();

		const page = await replies(alice, post.id, top.id).execute();
		expect(ids(page)).toEqual([third.id, second.id, first.id]);
		expect(page.every((entry) => entry.parent_id === top.id)).toBe(true);
		expect(ids(await replies(alice, post.id, top.id, `?before=${third.id}&limit=1`).execute())).toEqual([second.id]);
		expect(ids(await replies(alice, post.id, top.id, `?before=${first.id}`).execute())).toEqual([]);

		// The comment list keeps top-level comments only and says how many replies each has.
		const list = await comments(alice, post.id).execute();
		expect(ids(list)).toEqual([top.id]);
		expect(list[0]).toMatchObject({parent_id: null, reply_count: 3});

		await replies(alice, post.id, '1234567890')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		await reply(alice, post.id, '1234567890', 'boşluğa')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
	});

	it('answers 404 for a reply to a reply (depth 1)', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'tek seviye'}).execute();
		const top = await comment(alice, post.id, 'yorum').execute();
		const answer = await reply(bob, post.id, top.id, 'yanıt').execute();

		await reply(alice, post.id, answer.id, 'yanıta yanıt')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		await replies(alice, post.id, answer.id)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		await deleteReply(bob, post.id, answer.id, answer.id)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		// A reply is not a comment of its own.
		await deleteComment(bob, post.id, answer.id)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		expect(ids(await replies(alice, post.id, top.id).execute())).toEqual([answer.id]);
	});

	it('counts replies into comment_count and max_comments_per_post', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'sınırlı'}).execute();
		overrideLimits({max_comments_per_post: 3});

		const top = await comment(alice, post.id, 'yorum').execute();
		await reply(alice, post.id, top.id, 'bir').execute();
		const second = await reply(alice, post.id, top.id, 'iki').execute();
		await reply(alice, post.id, top.id, 'üç')
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.MAX_FEED_COMMENTS)
			.execute();
		await comment(alice, post.id, 'yeni').expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.MAX_FEED_COMMENTS).execute();
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 3});
		expect(await replyCountOf(alice, post.id, top.id)).toBe(2);

		await deleteReply(alice, post.id, top.id, second.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		await reply(alice, post.id, top.id, 'üç').execute();
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 3});

		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toMatchObject({comment_count: 3});
		expect(await storedCommentRow(post.id, top.id)).toMatchObject({reply_count: 2});
	});

	it('shares the stranger 20 per post allowance with comments', async () => {
		const [author, friend] = [await createTestAccount(harness), await createTestAccount(harness)];
		await createFriendship(harness, author, friend);
		await setProfileLevel(author, 100);
		const open = await createPost(harness, author, {content: 'açık', public: true}).execute();
		const top = await comment(author, open.id, 'yazarın yorumu').execute();

		for (let index = 0; index < 10; index++) await comment(friend, open.id, 'selam').execute();
		for (let index = 0; index < 10; index++) await reply(friend, open.id, top.id, 'selam').execute();
		await reply(friend, open.id, top.id, 'fazla').expect(TOO_MANY_REQUESTS, APIErrorCodes.RATE_LIMITED).execute();
		await comment(friend, open.id, 'fazla').expect(TOO_MANY_REQUESTS, APIErrorCodes.RATE_LIMITED).execute();
		// The post author is not capped.
		for (let index = 0; index < 21; index++) await reply(author, open.id, top.id, 'yazar').execute();
	});

	it('needs a verified 24 h account from a stranger on a public post', async () => {
		const [author, fresh, friend] = [
			await createTestAccount(harness),
			await createTestAccount(harness),
			await createTestAccount(harness),
		];
		const unverified = await createTestAccount(harness, {skipEmailVerification: true});
		await createFriendship(harness, author, friend);
		// the public bit is the author's level when posting; the author ends public.
		await setProfileLevel(author, 0);
		const closed = await createPost(harness, author, {content: 'gizli'}).execute();
		await setProfileLevel(author, 100);
		const open = await createPost(harness, author, {content: 'açık', public: true}).execute();
		const openTop = await comment(author, open.id, 'açık yorum').execute();
		const closedTop = await comment(author, closed.id, 'gizli yorum').execute();

		await reply(fresh, open.id, openTop.id, 'selam')
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		await reply(unverified, open.id, openTop.id, 'selam')
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED)
			.execute();
		// Profile access keeps today's rule: a friend replies however new the account.
		await reply(friend, open.id, openTop.id, 'arkadaş').execute();
		// A stranger reads the replies of a public post but not those of a post behind the profile rule.
		expect(await replies(fresh, open.id, openTop.id).execute()).toHaveLength(1);
		await replies(fresh, closed.id, closedTop.id).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		await reply(fresh, closed.id, closedTop.id, 'selam')
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();

		// A day later the stranger's account is old enough (the post is still inside its 72 hours).
		vi.useFakeTimers({now: Date.now() + 25 * HOUR_MS, toFake: ['Date']});
		await reply(fresh, open.id, openTop.id, 'artık olur').execute();
		expect(await replies(author, open.id, openTop.id).execute()).toHaveLength(2);
	});

	it('hides replies of accounts that block the stranger', async () => {
		const [author, blocker, other, stranger] = [
			await createTestAccount(harness),
			await createTestAccount(harness),
			await createTestAccount(harness),
			await createTestAccount(harness),
		];
		await createFriendship(harness, author, blocker);
		await createFriendship(harness, author, other);
		await setProfileLevel(author, 100);
		const open = await createPost(harness, author, {content: 'açık', public: true}).execute();
		const top = await comment(author, open.id, 'yorum').execute();
		const kept = await reply(other, open.id, top.id, 'görünür').execute();
		const hidden = await reply(blocker, open.id, top.id, 'gizlenir').execute();

		await blockUser(harness, blocker, stranger.userId);

		expect(ids(await replies(stranger, open.id, top.id).execute())).toEqual([kept.id]);
		// The newest page holds only the blocker's reply; the next page fills it.
		expect(ids(await replies(stranger, open.id, top.id, '?limit=1').execute())).toEqual([kept.id]);
		// The post author and the blocker's friends still see both.
		expect(ids(await replies(author, open.id, top.id).execute())).toEqual([hidden.id, kept.id]);
	});

	it('lets the reply author and the post author delete a reply and nobody else', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 3);
		const [bob, carol, dave] = members as [TestAccount, TestAccount, TestAccount];
		const post = await createPost(harness, alice, {content: 'sil'}).execute();
		const top = await comment(bob, post.id, 'bob yorumu').execute();
		const first = await reply(carol, post.id, top.id, 'bir').execute();
		const second = await reply(carol, post.id, top.id, 'iki').execute();
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 3});

		for (const account of [bob, dave]) {
			await deleteReply(account, post.id, top.id, first.id)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_PERMISSIONS)
				.execute();
		}
		await deleteReply(carol, post.id, top.id, first.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		await deleteReply(alice, post.id, top.id, second.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		await deleteReply(carol, post.id, top.id, first.id)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();

		expect(await replies(alice, post.id, top.id).execute()).toEqual([]);
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 1});
		expect(await replyCountOf(alice, post.id, top.id)).toBe(0);
	});

	it('deleting a comment drops its replies and lowers comment_count by 1 + N', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'zincir'}).execute();
		const top = await comment(bob, post.id, 'gidecek').execute();
		const kept = await comment(bob, post.id, 'kalacak').execute();
		const gone = [];
		for (const text of ['bir', 'iki', 'üç']) gone.push(await reply(alice, post.id, top.id, text).execute());
		const keptReply = await reply(alice, post.id, kept.id, 'kalır').execute();
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 6});

		await deleteComment(bob, post.id, top.id).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 2});
		expect(ids(await comments(alice, post.id).execute())).toEqual([kept.id]);
		await replies(alice, post.id, top.id).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT).execute();
		await reply(alice, post.id, top.id, 'geç')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		const repository = getFeedInteractionRepository();
		for (const entry of gone) {
			expect(await repository.getReply(BigInt(post.id), BigInt(top.id), BigInt(entry.id))).toBeNull();
		}
		expect(ids(await replies(alice, post.id, kept.id).execute())).toEqual([keptReply.id]);

		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toMatchObject({comment_count: 2});
	});

	it('recount counts replies', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'yeniden say'}).execute();
		const top = await comment(alice, post.id, 'yorum').execute();
		await comment(alice, post.id, 'ikinci').execute();
		await reply(alice, post.id, top.id, 'bir').execute();
		await reply(alice, post.id, top.id, 'iki').execute();
		const counters = getKVCounterService();
		const replyCounter = `${post.id}:${top.id}`;
		await counters.add(FEED_COMMENT_COUNT_COUNTER, post.id, -4);
		await counters.add(FEED_COMMENT_REPLY_COUNT_COUNTER, replyCounter, 5);

		await rebuildCounter({namespace: FEED_COMMENT_COUNT_COUNTER, id: post.id}, helpers);
		await rebuildCounter({namespace: FEED_COMMENT_REPLY_COUNT_COUNTER, id: replyCounter}, helpers);

		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 4});
		expect(await replyCountOf(alice, post.id, top.id)).toBe(2);
	});

	it("account deletion removes the account's replies and the export lists them with parent_id", async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const bobId = createUserID(BigInt(bob.userId));
		const post = await createPost(harness, alice, {content: 'hesap silinecek'}).execute();
		const top = await comment(alice, post.id, 'alice yorumu').execute();
		const first = await reply(bob, post.id, top.id, 'bir').execute();
		const own = await comment(bob, post.id, 'bob yorumu').execute();
		const second = await reply(bob, post.id, top.id, 'iki').execute();
		const kept = await reply(carol, post.id, top.id, 'kalır').execute();
		// Carol's reply under Bob's comment goes with it.
		await reply(carol, post.id, own.id, 'bob gidince gider').execute();

		const feedExport = (await collectUserHarvestExtensions({userId: bobId})).find((entry) => entry.name === 'feed');
		expect(feedExport?.data).toMatchObject({
			comments: [
				{id: second.id, post_id: post.id, parent_id: top.id, content: 'iki'},
				{id: own.id, post_id: post.id, content: 'bob yorumu'},
				{id: first.id, post_id: post.id, parent_id: top.id, content: 'bir'},
			],
		});
		const exported = (feedExport!.data as {comments: Array<Record<string, unknown>>}).comments;
		expect(exported[1]).not.toHaveProperty('parent_id');

		await runUserDeletionHook('feed', {userId: bobId});
		await runUserDeletionHook('feed', {userId: bobId});

		expect(ids(await replies(alice, post.id, top.id).execute())).toEqual([kept.id]);
		expect(ids(await comments(alice, post.id).execute())).toEqual([top.id]);
		expect(await getPost(alice, post.id).execute()).toMatchObject({comment_count: 2});
		expect(await replyCountOf(alice, post.id, top.id)).toBe(1);
		const afterDeletion = await collectUserHarvestExtensions({userId: bobId});
		expect(afterDeletion.find((entry) => entry.name === 'feed')?.data).toMatchObject({comments: []});
		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toMatchObject({comment_count: 2});
		expect(await storedCommentRow(post.id, top.id)).toMatchObject({reply_count: 1});
	});

	it('post deletion removes every reply partition', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'hepsi gider'}).execute();
		for (const text of ['bir', 'iki']) {
			const top = await comment(bob, post.id, text).execute();
			await reply(alice, post.id, top.id, `${text} yanıt`).execute();
			await reply(bob, post.id, top.id, `${text} yanıt 2`).execute();
		}
		const postId = BigInt(post.id);
		expect(await fetchMany(FETCH_POST_REPLIES_CQL, {post_id: postId})).toHaveLength(4);
		expect(await fetchMany(FETCH_POST_REPLY_BUCKETS_CQL, {post_id: postId})).toHaveLength(2);

		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await fetchMany(FETCH_POST_REPLIES_CQL, {post_id: postId})).toEqual([]);
		expect(await fetchMany(FETCH_POST_REPLY_BUCKETS_CQL, {post_id: postId})).toEqual([]);
		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toBeNull();
	});

	it('refuses a reply between a comment author and the replier when either blocks the other, with 404', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const post = await createPost(harness, alice, {content: 'engel'}).execute();
		const bobs = await comment(bob, post.id, 'bob yazdı').execute();
		const carols = await comment(carol, post.id, 'carol yazdı').execute();
		await blockUser(harness, bob, carol.userId);

		await reply(carol, post.id, bobs.id, 'taciz')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		await reply(bob, post.id, carols.id, 'geri')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		// Replies under one's own comment and from others stay open.
		await reply(bob, post.id, bobs.id, 'kendime').execute();
		await reply(alice, post.id, bobs.id, 'yazar').execute();
		expect(ids(await replies(alice, post.id, bobs.id).execute())).toHaveLength(2);
	});

	it('a reply racing its comment removal waits for it and answers 404: no orphan, no count, no notification', async () => {
		overrideLimits({feature_feed_reply_notifications: 1});
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'yarış'}).execute();
		const top = await comment(bob, post.id, 'silinecek').execute();
		const postId = BigInt(post.id);
		const repository = getFeedInteractionRepository();
		const service = getFeedInteractionService();
		const record = vi.spyOn(getFeedNotificationService(), 'record');
		const replier = (await getUserRepository().findUnique(createUserID(BigInt(alice.userId))))!;
		// The reply arrives while the removal holds the comment: its replies are being deleted.
		let racing: Promise<unknown> | null = null;
		const deleteReplies = repository.deleteCommentReplies.bind(repository);
		vi.spyOn(repository, 'deleteCommentReplies').mockImplementation(async (...args) => {
			racing = service
				.createReply(
					{user: replier, post: (await storedPostRow(post.id))!, commentId: BigInt(top.id), content: 'geç'},
					createRequestCache(),
				)
				.catch((error: unknown) => error);
			await Promise.race([racing, new Promise((resolve) => setTimeout(resolve, 50))]);
			return deleteReplies(...args);
		});

		await deleteComment(bob, post.id, top.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await racing).toBeInstanceOf(UnknownFeedCommentError);

		expect(await fetchMany(FETCH_POST_REPLIES_CQL, {post_id: postId})).toEqual([]);
		expect(await getKVCounterService().get(FEED_COMMENT_COUNT_COUNTER, post.id)).toBe(0);
		expect(record.mock.calls.filter(([entry]) => entry.type === 'comment_reply')).toEqual([]);
	});

	// the notification's own KV calls do not lengthen the comment lock the next reply waits on.
	it('records the reply notification once the comment lock is released', async () => {
		overrideLimits({feature_feed_reply_notifications: 1});
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'kilit'}).execute();
		const top = await comment(bob, post.id, 'üst').execute();
		const lockKey = `counter:lock:${FEED_COMMENT_COUNT_COUNTER}:${post.id}:${top.id}`;
		const lockHeld: Array<boolean> = [];
		vi.spyOn(getFeedNotificationService(), 'record').mockImplementation(async (entry) => {
			if (entry.type === 'comment_reply') lockHeld.push((await getKVClient().get(lockKey)) !== null);
		});

		await reply(alice, post.id, top.id, 'yanıt').execute();
		expect(lockHeld).toEqual([false]);
	});

	it('an orphan reply written after its comment went still goes with the post', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'yetim'}).execute();
		const top = await comment(bob, post.id, 'gidecek').execute();
		await reply(alice, post.id, top.id, 'bir').execute();
		await deleteComment(bob, post.id, top.id).expect(HTTP_STATUS.NO_CONTENT).execute();
		const postId = BigInt(post.id);

		// The only write that can still land under a removed comment: a reply of the account deletion's race.
		const replyId = await getSnowflakeService().generate();
		await getFeedInteractionRepository().createReply({
			post_id: postId,
			comment_id: BigInt(top.id),
			bucket: makeBucket(replyId),
			reply_id: replyId,
			author_id: createUserID(BigInt(alice.userId)),
			content: 'yetim',
			edited_at: null,
		});
		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect(await fetchMany(FETCH_POST_REPLIES_CQL, {post_id: postId})).toEqual([]);
		expect(await fetchMany(FETCH_POST_REPLY_BUCKETS_CQL, {post_id: postId})).toEqual([]);
	});

	it("keeps a hot comment's replies in ten day buckets", async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'sıcak yorum'}).execute();
		const top = await comment(alice, post.id, 'sıcak').execute();
		const postRow = (await getFeedRepository().getPost(BigInt(post.id)))!;
		const user = (await getUserRepository().findUnique(createUserID(BigInt(alice.userId))))!;
		const now = Date.now();
		const replyIds = [35, 34, 21, 2].map((ageDays) => createSnowflakeFromTimestamp(now - ageDays * DAY_MS));
		const snowflakes = vi.spyOn(getSnowflakeService(), 'generate');
		for (const replyId of replyIds) snowflakes.mockResolvedValueOnce(replyId);
		// The in-memory executor runs batch members through executeQuery too, so this sees every statement once.
		const statements = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeQuery');
		const created: Array<string> = [];
		for (let index = 0; index < replyIds.length; index++) {
			const entry = await getFeedInteractionService().createReply(
				{user, post: postRow, commentId: BigInt(top.id), content: `yanıt ${index}`},
				createRequestCache(),
			);
			created.unshift(entry.id);
		}

		const buckets = new Set(replyIds.map((replyId) => makeBucket(replyId)));
		const bucketWrites = statements.mock.calls.filter(([query]) =>
			/^(INSERT INTO|UPDATE) feed_comment_reply_buckets\s/.test(query.cql),
		);
		expect(bucketWrites).toHaveLength(buckets.size);
		const stored = await fetchMany<{bucket: number; reply_id: bigint}>(
			FeedCommentReplies.selectCql({columns: ['bucket', 'reply_id'], where: FeedCommentReplies.where.eq('post_id')}),
			{post_id: BigInt(post.id)},
		);
		for (const row of stored) expect(row.bucket).toBe(makeBucket(row.reply_id));

		const seen: Array<string> = [];
		let query = '?limit=1';
		for (;;) {
			const page = await replies(alice, post.id, top.id, query).execute();
			if (page.length === 0) break;
			seen.push(...ids(page));
			query = `?limit=1&before=${page.at(-1)!.id}`;
		}
		expect(seen).toEqual(created);
		expect(ids(await replies(alice, post.id, top.id, '?limit=50').execute())).toEqual(created);
	});

	it('answers 403 on every reply route while feature_feed is 0', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'kapanmadan önce'}).execute();
		const top = await comment(alice, post.id, 'yorum').execute();
		const answer = await reply(alice, post.id, top.id, 'yanıt').execute();

		overrideLimits({feature_feed: 0});
		for (const request of [
			reply(alice, post.id, top.id, 'kapalı'),
			replies(alice, post.id, top.id),
			deleteReply(alice, post.id, top.id, answer.id),
		]) {
			await request.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
		}
	});
});
