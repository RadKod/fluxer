// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {blockUser, createFriendship, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {fetchOne} from '@app/api/database/CassandraQueryExecution';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {feedDiscoverCache} from '@app/api/feed/discover/FeedDiscoverCache';
import {FeedPosts} from '@app/api/feed/FeedTables';
import {FEED_POLL_VOTE_COUNT_COUNTER} from '@app/api/feed/interaction/FeedInteractionCounters';
import {
	captureJobs,
	createPost,
	followDirectly,
	getHome,
	runFanout,
	setProfileLevel,
} from '@app/api/feed/tests/FeedTestUtils';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedDiscoverRepository,
	getFeedInteractionRepository,
	getFeedRepository,
	getFeedTimelineService,
	getKVCounterService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder, type TestRequestBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import flushCounters from '@app/api/worker/tasks/FlushCounters';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import type {FeedPostListResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import type {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const HOUR = 3_600_000;
const FETCH_POST_ROW_CQL = FeedPosts.selectCql({where: FeedPosts.where.eq('post_id'), limit: 1});
const POLL = {options: ['Elma', 'Armut'], duration_hours: 48};

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

type ErrorBody = {code: string; errors?: Array<{path: string; code: string}>};

describe('feed polls', () => {
	let harness: ApiTestHarness;
	let kv: MockKVProvider;

	const accounts = async (count: number) => Promise.all(Array.from({length: count}, () => createTestAccount(harness)));
	// a poll post is public while its author is public (100), else written at 0.
	async function pollPost(author: TestAccount, body: {public?: boolean; poll?: object} = {}) {
		await setProfileLevel(author, body.public === false ? 0 : 100);
		return createPost(harness, author, {content: 'Hangisi?', poll: POLL, ...body}).execute();
	}
	const vote = (account: TestAccount, postId: string, option: number) =>
		createBuilder<FeedPostResponse>(harness, account.token).put(`/feed/posts/${postId}/poll/vote`).body({option});
	const getPost = (account: TestAccount, postId: string) =>
		createBuilder<FeedPostResponse>(harness, account.token).get(`/feed/posts/${postId}`);
	const discover = (account: TestAccount) =>
		createBuilder<FeedPostListResponse>(harness, account.token).get('/feed/discover');
	const invalidFormat = async (request: TestRequestBuilder<unknown>, path: string) => {
		const json = (await request.expect(HTTP_STATUS.BAD_REQUEST).executeWithResponse()).json as ErrorBody;
		expect(json.code).toBe(APIErrorCodes.INVALID_FORM_BODY);
		expect(json.errors?.find((entry) => entry.path === path)?.code).toBe(ValidationErrorCodes.INVALID_FORMAT);
	};
	const storedPostRow = (postId: string) => fetchOne<FeedPostRow>(FETCH_POST_ROW_CQL, {post_id: BigInt(postId)});
	async function addFlag(account: TestAccount, flag: bigint): Promise<void> {
		const id = createUserID(BigInt(account.userId));
		const user = (await getUserRepository().findUnique(id))!;
		await getUserRepository().patchUpsert(id, {flags: user.flags | flag}, user.toRow());
	}
	// The Keşfet list as the cron builds it a day ahead (test accounts are brand new, authors need 24 h), then read.
	async function publishToDiscover(postId: string): Promise<void> {
		await getFeedDiscoverRepository().rankPost(BigInt(postId), 1);
		await getKVClient().del('feed:discover:build');
		await getFeedTimelineService().discover.buildSnapshot(Date.now() + 25 * HOUR);
		await feedDiscoverCache.refresh();
	}
	const feedExport = async (userId: UserID) =>
		(await collectUserHarvestExtensions({userId})).find((entry) => entry.name === 'feed')?.data as
			| Record<string, unknown>
			| undefined;

	beforeAll(async () => {
		harness = await createApiTestHarness();
		kv = harness.kvProvider as MockKVProvider;
	});
	beforeEach(async () => {
		await harness.reset();
		// harness.reset() drops the pub/sub callbacks; shut the old subscription down before opening a new one.
		await feedDiscoverCache.shutdown();
		feedDiscoverCache.resetForTesting();
		feedDiscoverCache.setRefreshSubscriber(getKVClient());
		await feedDiscoverCache.initialize();
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await feedDiscoverCache.shutdown();
		await harness?.shutdown();
	});

	it('creates a text post with a poll and reads it back with results hidden from another reader', async () => {
		const [author, reader] = await accounts(2);
		const post = await pollPost(author!);
		const expiresAt = new Date(snowflakeToDate(BigInt(post.id)).getTime() + 48 * HOUR).toISOString();
		expect(post.poll).toEqual({options: ['Elma', 'Armut'], expires_at: expiresAt, votes: [0, 0], voted: null});

		expect((await getPost(reader!, post.id).execute()).poll).toEqual({
			options: ['Elma', 'Armut'],
			expires_at: expiresAt,
			votes: null,
			voted: null,
		});
		expect(await createPost(harness, author!, {content: 'anketsiz'}).execute()).not.toHaveProperty('poll');
	});

	it('refuses a poll without text, with images, with duplicate options or with a video', async () => {
		const [author] = await accounts(1);
		const upload = {id: 0, filename: 'a.png', upload_filename: 'u/a.png', file_size: 10, content_type: 'image/png'};
		const video = {...upload, filename: 'v.mp4', upload_filename: 'u/v.mp4', content_type: 'video/mp4'};

		await createPost(harness, author!, {poll: POLL})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CANNOT_SEND_EMPTY_MESSAGE)
			.execute();
		await invalidFormat(createPost(harness, author!, {content: 'q', poll: POLL, attachments: [upload]}), 'poll');
		await invalidFormat(createPost(harness, author!, {content: 'q', poll: POLL, attachments: [video]}), 'poll');
		await invalidFormat(
			createPost(harness, author!, {content: 'q', poll: {options: ['Evet', ' EVET '], duration_hours: 1}}),
			'poll.options',
		);
		expect(await getFeedRepository().listAuthorPostIds(createUserID(BigInt(author!.userId)), {limit: 10})).toEqual([]);
	});

	it('finds repeated options the way the composer does: trimmed and lowercased without Turkish casing', async () => {
		const [author] = await accounts(1);
		const post = await pollPost(author!, {poll: {options: ['Işık', 'ışık'], duration_hours: 1}});
		expect(post.poll?.options).toEqual(['Işık', 'ışık']);
	});

	it('counts one vote and shows the voter the results', async () => {
		const [author, voter] = await accounts(2);
		const post = await pollPost(author!);

		const answer = await vote(voter!, post.id, 0).execute();
		expect(answer).toMatchObject({id: post.id, poll: {votes: [1, 0], voted: 0}});
		expect((await getPost(voter!, post.id).execute()).poll).toMatchObject({votes: [1, 0], voted: 0});
	});

	it('answers 409 to a second vote, even when both race', async () => {
		const [author, voter, racer] = await accounts(3);
		const post = await pollPost(author!);
		await vote(voter!, post.id, 0).execute();
		await vote(voter!, post.id, 1).expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT).execute();

		const raced = await Promise.allSettled([
			vote(racer!, post.id, 1).executeRaw(),
			vote(racer!, post.id, 1).executeRaw(),
		]);
		const statuses = raced.map((entry) => (entry.status === 'fulfilled' ? entry.value.response.status : 0));
		expect(statuses.sort()).toEqual([HTTP_STATUS.OK, HTTP_STATUS.CONFLICT]);
		expect(await getKVCounterService().get(FEED_POLL_VOTE_COUNT_COUNTER, `${post.id}:1`)).toBe(1);
		expect((await getPost(author!, post.id).execute()).poll?.votes).toEqual([1, 1]);

		await flushCounters({}, helpers);
		expect(await storedPostRow(post.id)).toMatchObject({poll_vote_count_0: 1, poll_vote_count_1: 1});
		// With the KV counters and the post cache gone, the counts come from the flushed row.
		for (const pattern of ['counter:*', 'feed:post:*']) {
			await harness.kvProvider.del(...(await harness.kvProvider.scan(pattern, 1_000_000)));
		}
		expect((await getPost(author!, post.id).execute()).poll?.votes).toEqual([1, 1]);
	});

	it("refuses the author's own vote with 403 but shows the author the results", async () => {
		const [author, voter] = await accounts(2);
		const post = await pollPost(author!);
		await vote(author!, post.id, 0).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_PERMISSIONS).execute();
		await vote(voter!, post.id, 1).execute();
		expect((await getPost(author!, post.id).execute()).poll).toMatchObject({votes: [0, 1], voted: null});
	});

	it('answers 400 for an option past the last one and for a post without a poll', async () => {
		const [author, voter] = await accounts(2);
		const post = await pollPost(author!);
		const plain = await createPost(harness, author!, {content: 'anketsiz', public: true}).execute();
		await invalidFormat(vote(voter!, post.id, 2), 'option');
		await invalidFormat(vote(voter!, plain.id, 0), 'option');
		expect((await getPost(author!, post.id).execute()).poll?.votes).toEqual([0, 0]);
	});

	it('answers 409 after the poll ends and shows everyone the results', async () => {
		const [author, voter, reader] = await accounts(3);
		const post = await pollPost(author!, {poll: {options: ['a', 'b'], duration_hours: 1}});
		await vote(voter!, post.id, 0).execute();

		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * HOUR);
		await vote(reader!, post.id, 1).expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT).execute();
		expect((await getPost(reader!, post.id).execute()).poll).toMatchObject({votes: [1, 0], voted: null});
	});

	it('poll results stay hidden on every read path until the viewer votes or it ends', async () => {
		const {owner: author, members} = await setupTestGuildWithMembers(harness, 2);
		const [reader, voter] = members as [TestAccount, TestAccount];
		await followDirectly(reader.userId, author.userId);
		const jobs = captureJobs();
		const post = await pollPost(author);
		await runFanout(jobs);
		await publishToDiscover(post.id);
		await vote(voter, post.id, 1).execute();

		const reads = async (): Promise<Array<FeedPostResponse | undefined>> => {
			const pages = await Promise.all([
				getHome(harness, reader).execute(),
				createBuilder<FeedPostListResponse>(harness, reader.token).get(`/users/${author.userId}/posts`).execute(),
				discover(reader).execute(),
			]);
			return [
				await getPost(reader, post.id).execute(),
				...pages.map((page) => page.find((entry) => entry.id === post.id)),
			];
		};
		const before = await reads();
		expect(before.every((entry) => entry !== undefined)).toBe(true);
		for (const entry of before) expect(entry!.poll).toMatchObject({votes: null, voted: null});

		await vote(reader, post.id, 0).execute();
		for (const entry of await reads()) {
			expect(entry!.poll?.voted).toBe(0);
			expect(entry!.poll?.votes).not.toBeNull();
		}
	});

	it('refuses a vote on a non-public poll from a stranger and allows it on a public one', async () => {
		const [author, stranger] = await accounts(2);
		const hidden = await pollPost(author!, {public: false});
		await vote(stranger!, hidden.id, 0).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		const open = await pollPost(author!);
		expect((await vote(stranger!, open.id, 0).execute()).poll).toMatchObject({votes: [1, 0], voted: 0});
	});

	it("refuses a vote on a public poll from a stranger without a verified email; a friend's vote keeps today's rule", async () => {
		const [author, stranger, friend] = await accounts(3);
		await createFriendship(harness, author!, friend!);
		for (const account of [stranger!, friend!]) {
			await createBuilder(harness, '')
				.post(`/test/users/${account.userId}/security-flags`)
				.body({email_verified: false, suspicious_activity_flags: 0})
				.execute();
		}
		const post = await pollPost(author!);

		await vote(stranger!, post.id, 0)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED)
			.execute();
		expect((await vote(friend!, post.id, 0).execute()).poll).toMatchObject({voted: 0});
	});

	it('refuses a vote when either side blocks and on a poll by a hidden author', async () => {
		for (const blocker of ['author', 'viewer'] as const) {
			const [author, viewer] = await accounts(2);
			const post = await pollPost(author!);
			await (blocker === 'author'
				? blockUser(harness, author!, viewer!.userId)
				: blockUser(harness, viewer!, author!.userId));
			await vote(viewer!, post.id, 0).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST).execute();
		}
		const [author, viewer] = await accounts(2);
		const post = await pollPost(author!);
		await addFlag(author!, UserFlags.DISABLED_SUSPICIOUS_ACTIVITY);
		await vote(viewer!, post.id, 0).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST).execute();
	});

	it("a Keşfet page shows the snapshot's poll counts and the vote answer the live ones", async () => {
		const [author, viewer] = await accounts(2);
		const post = await pollPost(author!);
		await publishToDiscover(post.id);

		expect((await vote(viewer!, post.id, 0).execute()).poll).toMatchObject({votes: [1, 0], voted: 0});
		kv.mgetSpy.mockClear();
		const shown = (await discover(viewer!).execute()).find((entry) => entry.id === post.id);
		expect(shown?.poll).toMatchObject({votes: [0, 0], voted: 0});
		const keys = (kv.mgetSpy.mock.calls as Array<Array<string>>).flat();
		expect(keys.filter((key) => key.startsWith('counter:'))).toEqual([]);
	});

	it("deletes the poll's votes with the post and an account's votes with the account, and exports them", async () => {
		const [author, voter] = await accounts(2);
		const authorId = createUserID(BigInt(author!.userId));
		const voterId = createUserID(BigInt(voter!.userId));
		const gone = await pollPost(author!);
		const kept = await pollPost(author!, {poll: {options: ['x', 'y', 'z'], duration_hours: 24}});
		await vote(voter!, gone.id, 0).execute();
		await vote(voter!, kept.id, 2).execute();
		const repository = getFeedInteractionRepository();
		expect(await repository.countPollVotes(BigInt(gone.id), 0)).toBe(1);

		expect(await feedExport(voterId)).toMatchObject({
			poll_votes: [
				{post_id: kept.id, option: 2},
				{post_id: gone.id, option: 0},
			],
		});
		expect(await feedExport(authorId)).toMatchObject({
			posts: [
				{id: kept.id, public: true, poll: {options: ['x', 'y', 'z'], expires_at: kept.poll!.expires_at}},
				{id: gone.id, public: true, poll: {options: ['Elma', 'Armut']}},
			],
		});

		await createBuilder(harness, author!.token)
			.delete(`/feed/posts/${gone.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await repository.countPollVotes(BigInt(gone.id), 0)).toBe(0);

		await runUserDeletionHook('feed', {userId: voterId});
		await runUserDeletionHook('feed', {userId: voterId});
		expect(await repository.countPollVotes(BigInt(kept.id), 2)).toBe(0);
		expect((await getPost(author!, kept.id).execute()).poll?.votes).toEqual([0, 0, 0]);
		expect(await feedExport(voterId)).not.toHaveProperty('poll_votes');
	});

	it('a cached post row keeps poll_expires_at as a date', async () => {
		const [author] = await accounts(1);
		const post = await pollPost(author!);
		await getKVClient().del(`feed:post:${post.id}`);
		const fromCassandra = await getFeedRepository().getPost(BigInt(post.id));
		const fromCache = await getFeedRepository().getPost(BigInt(post.id));
		expect(fromCache?.poll_expires_at).toBeInstanceOf(Date);
		expect(fromCache).toEqual(fromCassandra);
	});
});
