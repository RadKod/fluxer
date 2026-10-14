// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {createTestBotAccount} from '@app/api/bot/tests/BotTestUtils';
import {blockUser, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {captureJobs, createPost, overrideLimits, type QueuedJob} from '@app/api/feed/tests/FeedTestUtils';
import {Logger} from '@app/api/Logger';
import {
	getFeedNotificationRepository,
	getFeedNotificationService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {removeRelationship} from '@app/api/user/tests/RelationshipTestUtils';
import aggregateFeedNotification from '@app/api/worker/tasks/AggregateFeedNotification';
import type {
	FeedNotificationAckResponse,
	FeedNotificationCreateEvent,
	FeedNotificationStateResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

// The feed lane's jobs, run without waiting for run_at; jobs they queue stay in `jobs` for the next call.
async function runNotificationJobs(jobs: Array<QueuedJob>): Promise<void> {
	for (const job of jobs.splice(0)) {
		if (job.task === 'aggregateFeedNotification') await aggregateFeedNotification(job.payload, helpers);
	}
}

function events<T>(dispatch: {mock: {calls: Array<Array<unknown>>}}, event: string) {
	return dispatch.mock.calls
		.map(([params]) => params as {userId: UserID; event: string; data: T})
		.filter((params) => params.event === event);
}

// A fixed clock with at least five minutes left in its hour, so every offset a test adds (≤ 2 min) stays inside one
// aggregation hour. Never in the past: sessions made before the clock is fixed stay valid.
const fixedNow = () => {
	const now = Date.now();
	const hour = 3_600_000;
	return now % hour < hour - 300_000 ? now : Math.ceil(now / hour) * hour + 60_000;
};

describe('feed notification unread state (2a.9b)', () => {
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

	// Public, so accounts that share no community with the author may like it (Fluxer's profile access rule).
	const post = async (account: TestAccount, content: string) =>
		(await createPost(harness, account, {content, public: true}).execute()).id;
	const like = (account: TestAccount, postId: string) =>
		createBuilder(harness, account.token).put(`/feed/posts/${postId}/like`).expect(HTTP_STATUS.NO_CONTENT).execute();
	const ready = async (account: TestAccount) =>
		(
			await createBuilder<{data: {feed_notification_state?: FeedNotificationStateResponse}}>(harness, '')
				.post('/test/rpc-session-init')
				.body({type: 'session', token: account.token, version: 1, ip: '127.0.0.1'})
				.expect(HTTP_STATUS.OK)
				.execute()
		).data.feed_notification_state;
	const ack = (account: TestAccount, readAt: string, seenSeq = 0, seenEpoch = 0) =>
		createBuilder<FeedNotificationAckResponse>(harness, account.token)
			.post('/feed/notifications/ack')
			.body({read_at: readAt, unread_seq: seenSeq, unread_epoch: seenEpoch});
	// The account's unread hash (fields seq, acked, ready, epoch).
	const unreadKey = (account: TestAccount) => `feed:notif:unread:${account.userId}`;
	// The epoch a session that has seen the current sequence holds (READY, pushes, acks).
	const epochOf = async (account: TestAccount) =>
		Number((await harness.kvProvider.hget(unreadKey(account), 'epoch')) ?? 0);

	it('raises the unread sequence once for each notification that becomes unread and pushes it (S2-T1)', async () => {
		const alice = await createTestAccount(harness);
		const [bob, carol] = await Promise.all([createTestAccount(harness), createTestAccount(harness)]);
		const first = await post(alice, 'bir');
		const second = await post(alice, 'iki');
		const now = fixedNow();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		const dispatch = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
		const pushes = () => events<FeedNotificationCreateEvent>(dispatch, 'FEED_NOTIFICATION_CREATE').map((e) => e.data);

		await like(bob, first);
		await runNotificationJobs(jobs);
		expect(pushes().map((push) => push.unread_seq)).toEqual([1]);

		// Another account on the same unread row folds into it: nothing new became unread.
		clock.mockReturnValue(now + 1_000);
		await like(carol, first);
		await runNotificationJobs(jobs);
		// A second post is a second notification; its push waits for the minute and carries the newest sequence.
		await like(bob, second);
		await runNotificationJobs(jobs);
		expect(pushes()).toHaveLength(1);
		clock.mockReturnValue(now + 61_000);
		await runNotificationJobs(jobs);
		expect(pushes().at(-1)).toMatchObject({post_id: second, unread_seq: 2});
		expect(await harness.kvProvider.hget(unreadKey(alice), 'seq')).toBe('2');
	});

	it('counts unread notifications in READY, without blocked accounts, up to 10 (S3-T1, T2, T3)', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const posts = [];
		for (let index = 0; index < 12; index++) posts.push(await post(alice, `p${index}`));
		vi.spyOn(Date, 'now').mockReturnValue(fixedNow());
		const jobs = captureJobs();
		for (const postId of posts) {
			await like(bob, postId);
			await runNotificationJobs(jobs);
		}
		await like(carol, posts[0]!);
		await runNotificationJobs(jobs);
		expect(await ready(alice)).toEqual({
			last_read_at: null,
			unread_count: 10,
			unread_seq: 12,
			unread_epoch: await epochOf(alice),
		});
		// Blocking bob changes the blocked accounts the cached count was made with, so READY recounts: only carol's row.
		await blockUser(harness, alice, bob.userId);
		expect(await ready(alice)).toMatchObject({unread_count: 1});
		// Unblocking him changes them again: bob's rows count again.
		await removeRelationship(harness, alice.token, bob.userId);
		expect(await ready(alice)).toMatchObject({unread_count: 10});
	});

	it('leaves the field out for bots and with feature_feed at 0 (S3-T4)', async () => {
		const bot = await createTestBotAccount(harness);
		const botUser = (await getUserRepository().findUnique(createUserID(BigInt(bot.botUserId))))!;
		expect(await getFeedNotificationService().getReadyState(botUser, [])).toBeUndefined();
		const alice = await createTestAccount(harness);
		overrideLimits({feature_feed: 0});
		expect(await ready(alice)).toBeUndefined();
	});

	it('still sends READY when the feed state fails or is slow, and logs 1 failure in 1000 (kapı Ş1, denetim O9, S3-T5)', async () => {
		const alice = await createTestAccount(harness);
		const repository = getFeedNotificationRepository();
		vi.spyOn(repository, 'getReadState').mockRejectedValueOnce(new Error('cassandra down'));
		expect(await ready(alice)).toBeUndefined();
		vi.spyOn(repository, 'getReadState').mockReturnValueOnce(new Promise(() => {}));
		const startedAt = performance.now();
		expect(await ready(alice)).toBeUndefined();
		expect(performance.now() - startedAt).toBeLessThan(2_000);

		const user = (await getUserRepository().findUnique(createUserID(BigInt(alice.userId))))!;
		vi.spyOn(repository, 'getReadState').mockRejectedValue(new Error('cassandra down'));
		// The app Logger is a proxy; its child() is the logger behind it (FeedViewService.test.ts pattern).
		const warn = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
		for (let index = 0; index < 1000; index++) {
			expect(await getFeedNotificationService().getReadyState(user, [])).toBeUndefined();
		}
		const logged = (warn.mock.calls as Array<Array<unknown>>).filter(([, message]) =>
			String(message).includes('feed notification state'),
		);
		expect(logged).toHaveLength(1);
	});

	it('gives READY the sequence its count includes, so a held push adds nothing (S3-T6)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const first = await post(alice, 'a');
		const second = await post(alice, 'b');
		const now = fixedNow();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		const dispatch = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
		await like(bob, first);
		await runNotificationJobs(jobs);
		await like(bob, second);
		await runNotificationJobs(jobs);
		const state = (await ready(alice))!;
		expect(state).toMatchObject({unread_count: 2, unread_seq: 2});
		clock.mockReturnValue(now + 61_000);
		await runNotificationJobs(jobs);
		const held = events<FeedNotificationCreateEvent>(dispatch, 'FEED_NOTIFICATION_CREATE').at(-1)!.data;
		expect(held.post_id).toBe(second);
		expect(held.unread_seq - state.unread_seq).toBe(0);
	});

	it('answers READY from the cache while the sequence holds, unread notifications included (denetim O5, S3-T7)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const postId = await post(alice, 'önbellek');
		const jobs = captureJobs();
		await like(bob, postId);
		await runNotificationJobs(jobs);
		expect(await ready(alice)).toMatchObject({unread_count: 1, unread_seq: 1});
		const repository = getFeedNotificationRepository();
		const reads = [vi.spyOn(repository, 'getReadState'), vi.spyOn(repository, 'list')];
		expect(await ready(alice)).toMatchObject({unread_count: 1, unread_seq: 1});
		expect(reads.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
	});

	it('reads once when the cache is lost and writes it again (bayrak kaybı = bir kez oku, S3-T8)', async () => {
		const alice = await createTestAccount(harness);
		await ready(alice);
		await harness.kvProvider.hdel(unreadKey(alice), 'ready');
		const cursorReads = vi.spyOn(getFeedNotificationRepository(), 'getReadState');
		expect(await ready(alice)).toMatchObject({unread_count: 0});
		expect(await ready(alice)).toMatchObject({unread_count: 0});
		expect(cursorReads).toHaveBeenCalledTimes(1);
	});

	it('reads again when a notification raised the sequence while READY was counting (S3-T9)', async () => {
		const alice = await createTestAccount(harness);
		const repository = getFeedNotificationRepository();
		const list = repository.list.bind(repository);
		// An increment between READY's sequence read and its cache write, as a notification job landing mid-READY does.
		vi.spyOn(repository, 'list').mockImplementationOnce(async (...args) => {
			await harness.kvProvider.hincrby(unreadKey(alice), 'seq', 1);
			return list(...args);
		});
		expect(await ready(alice)).toMatchObject({unread_count: 0, unread_seq: 0});
		const cursorReads = vi.spyOn(repository, 'getReadState');
		expect(await ready(alice)).toMatchObject({unread_count: 0, unread_seq: 1});
		expect(cursorReads).toHaveBeenCalledTimes(1);
	});

	it('loses the sequence, the read and the cache together, and READY then reads once (Epha 16:51 tek hash, Y1, S3-T10)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const first = await post(alice, 'bir');
		const second = await post(alice, 'iki');
		const now = fixedNow();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		await like(bob, first);
		await runNotificationJobs(jobs);
		const firstEpoch = await epochOf(alice);
		await ack(alice, new Date(now).toISOString(), 1, firstEpoch).expect(HTTP_STATUS.OK).execute();
		expect(await ready(alice)).toMatchObject({unread_count: 0, unread_seq: 1, unread_epoch: firstEpoch});
		expect(Object.keys(await harness.kvProvider.hgetall(unreadKey(alice))).sort()).toEqual([
			'acked',
			'epoch',
			'ready',
			'seq',
		]);
		expect(await harness.kvProvider.ttl(unreadKey(alice))).toBeGreaterThan(23 * 3600);
		// A day with no increment, read or READY miss: all three fields expire at once (one key, one TTL), so no cache can
		// outlive its sequence and match a sequence born again.
		clock.mockReturnValue(now + 24 * 3_600_000 + 1_000);
		expect(await harness.kvProvider.hgetall(unreadKey(alice))).toEqual({});
		clock.mockReturnValue(now + 2_000);
		await like(bob, second);
		await runNotificationJobs(jobs);
		const cursorReads = vi.spyOn(getFeedNotificationRepository(), 'getReadState');
		expect(await ready(alice)).toMatchObject({unread_count: 1, unread_seq: 1});
		expect(cursorReads).toHaveBeenCalledTimes(1);
		// The sequence started again under a later epoch, so a client resets its base instead of waiting for 2.
		expect((await ready(alice))!.unread_epoch).toBeGreaterThan(firstEpoch);
	});

	it('moves the cursor forward only and never past the server time (S4-T1, T2)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const postId = await post(alice, 'oku');
		const now = fixedNow();
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		await like(bob, postId);
		await runNotificationJobs(jobs);
		const updatedAt = new Date(now).toISOString();
		expect(await ready(alice)).toMatchObject({unread_count: 1});

		const epoch = await epochOf(alice);
		expect(await ack(alice, updatedAt, 1, epoch).expect(HTTP_STATUS.OK).execute()).toEqual({
			last_read_at: updatedAt,
			unread_seq: 1,
			unread_epoch: epoch,
		});
		expect(await ready(alice)).toEqual({
			last_read_at: updatedAt,
			unread_count: 0,
			unread_seq: 1,
			unread_epoch: epoch,
		});
		const older = new Date(now - 3_600_000).toISOString();
		expect(await ack(alice, older, 1).expect(HTTP_STATUS.OK).execute()).toMatchObject({last_read_at: updatedAt});
		const future = new Date(now + 86_400_000).toISOString();
		expect(await ack(alice, future, 1).expect(HTTP_STATUS.OK).execute()).toMatchObject({last_read_at: updatedAt});
	});

	it('counts a read notification again when it moves after the read (S4-T3)', async () => {
		const alice = await createTestAccount(harness);
		const [bob, carol] = await Promise.all([createTestAccount(harness), createTestAccount(harness)]);
		const postId = await post(alice, 'tekrar');
		const now = fixedNow();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		const dispatch = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
		await like(bob, postId);
		await runNotificationJobs(jobs);
		await ack(alice, new Date(now).toISOString(), 1, await epochOf(alice))
			.expect(HTTP_STATUS.OK)
			.execute();
		clock.mockReturnValue(now + 120_000);
		await like(carol, postId);
		await runNotificationJobs(jobs);
		expect(await ready(alice)).toMatchObject({unread_count: 1, unread_seq: 2});
		expect(events<FeedNotificationCreateEvent>(dispatch, 'FEED_NOTIFICATION_CREATE').at(-1)!.data.unread_seq).toBe(2);
	});

	it("tells only the reader's own sessions, with the response as payload (S4-T4)", async () => {
		const alice = await createTestAccount(harness);
		const dispatch = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
		const response = await ack(alice, new Date().toISOString()).expect(HTTP_STATUS.OK).execute();
		expect(events<FeedNotificationAckResponse>(dispatch, 'FEED_NOTIFICATION_ACK')).toEqual([
			{userId: createUserID(BigInt(alice.userId)), event: 'FEED_NOTIFICATION_ACK', data: response},
		]);
	});

	it('answers 400 without an ISO time or the seen sequence, and 403 with feature_feed at 0 (S4-T5)', async () => {
		const alice = await createTestAccount(harness);
		await ack(alice, 'dün').expect(HTTP_STATUS.BAD_REQUEST).execute();
		await createBuilder(harness, alice.token)
			.post('/feed/notifications/ack')
			.body({read_at: new Date().toISOString()})
			.expect(HTTP_STATUS.BAD_REQUEST)
			.execute();
		overrideLimits({feature_feed: 0});
		await ack(alice, new Date().toISOString()).expect(HTTP_STATUS.FORBIDDEN).execute();
	});

	it('drops the READY cache on a read, so the next READY reads once (S4-T6)', async () => {
		const alice = await createTestAccount(harness);
		await ready(alice);
		expect(await harness.kvProvider.hget(unreadKey(alice), 'ready')).not.toBeNull();
		await ack(alice, new Date().toISOString()).expect(HTTP_STATUS.OK).execute();
		expect(await harness.kvProvider.hget(unreadKey(alice), 'ready')).toBeNull();
	});

	it('does not count a notification whose action is older than the read, even when written after it (denetim O1, S4-T7)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const postId = await post(alice, 'geç yazılan');
		const now = fixedNow();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		await like(bob, postId);
		clock.mockReturnValue(now + 5_000);
		await ack(alice, new Date(now + 5_000).toISOString())
			.expect(HTTP_STATUS.OK)
			.execute();
		// The aggregation job writes the row after the read; its action is older than the cursor.
		await runNotificationJobs(jobs);
		expect(await harness.kvProvider.hget(unreadKey(alice), 'seq')).toBeNull();
		expect(await ready(alice)).toMatchObject({unread_count: 0, unread_seq: 0});
	});

	it('reads only up to the sequence the session saw, never past the server one, never back (denetim Y3, S4-T8)', async () => {
		const alice = await createTestAccount(harness);
		const [bob, carol] = await Promise.all([createTestAccount(harness), createTestAccount(harness)]);
		const first = await post(alice, 'bir');
		const second = await post(alice, 'iki');
		const now = fixedNow();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		await like(bob, first);
		await runNotificationJobs(jobs);
		clock.mockReturnValue(now + 1_000);
		// Sequence 2: its push is held for the minute, so the session has seen only 1.
		await like(bob, second);
		await runNotificationJobs(jobs);
		const readAt = new Date(now).toISOString();
		const epoch = await epochOf(alice);
		expect(await ack(alice, readAt, 1, epoch).expect(HTTP_STATUS.OK).execute()).toEqual({
			last_read_at: readAt,
			unread_seq: 1,
			unread_epoch: epoch,
		});
		expect(await ready(alice)).toMatchObject({unread_count: 1, unread_seq: 2});
		// The held notification moves again: it was counted after the read, so it is not counted twice.
		clock.mockReturnValue(now + 2_000);
		await like(carol, second);
		await runNotificationJobs(jobs);
		expect(await harness.kvProvider.hget(unreadKey(alice), 'seq')).toBe('2');
		// A session cannot read past the server's sequence, nor take a later read back.
		expect(await ack(alice, readAt, 99, epoch).expect(HTTP_STATUS.OK).execute()).toMatchObject({unread_seq: 2});
		expect(await ack(alice, readAt, 0, epoch).expect(HTTP_STATUS.OK).execute()).toMatchObject({unread_seq: 2});
	});

	it('answers READY with epoch 0 before the unread state exists, and a read starts it (D1)', async () => {
		const alice = await createTestAccount(harness);
		expect(await ready(alice)).toMatchObject({unread_seq: 0, unread_epoch: 0});
		const answer = await ack(alice, new Date().toISOString()).expect(HTTP_STATUS.OK).execute();
		expect(answer.unread_epoch).toBeGreaterThan(0);
		expect(answer.unread_epoch).toBe(await epochOf(alice));
		expect(await ready(alice)).toMatchObject({unread_epoch: answer.unread_epoch});
	});

	it('pushes the epoch, and reads none of the sequence for a session that saw another epoch (D1)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const postId = await post(alice, 'devir');
		const now = fixedNow();
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		const dispatch = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
		await like(bob, postId);
		await runNotificationJobs(jobs);
		const epoch = await epochOf(alice);
		expect(events<FeedNotificationCreateEvent>(dispatch, 'FEED_NOTIFICATION_CREATE').at(-1)!.data).toMatchObject({
			unread_seq: 1,
			unread_epoch: epoch,
		});
		// A session still on the sequence of an expired hash says it saw 57: that is nothing of this one.
		const readAt = new Date(now - 60_000).toISOString();
		expect(
			await ack(alice, readAt, 57, epoch - 1)
				.expect(HTTP_STATUS.OK)
				.execute(),
		).toMatchObject({
			unread_seq: 0,
			unread_epoch: epoch,
		});
		expect(await ack(alice, readAt, 57, epoch).expect(HTTP_STATUS.OK).execute()).toMatchObject({unread_seq: 1});
		expect(events<FeedNotificationAckResponse>(dispatch, 'FEED_NOTIFICATION_ACK').at(-1)!.data.unread_epoch).toBe(
			epoch,
		);
	});

	it('recounts when a read lands while READY counts (D2, S3-T9 pattern)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const postId = await post(alice, 'yarış');
		const now = fixedNow();
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		await like(bob, postId);
		await runNotificationJobs(jobs);
		const epoch = await epochOf(alice);
		const repository = getFeedNotificationRepository();
		const list = repository.list.bind(repository);
		// Another device marks read between READY's cursor read and its cache write.
		vi.spyOn(repository, 'list').mockImplementationOnce(async (...args) => {
			await ack(alice, new Date(now).toISOString(), 1, epoch).expect(HTTP_STATUS.OK).execute();
			return list(...args);
		});
		await ready(alice);
		const cursorReads = vi.spyOn(repository, 'getReadState');
		expect(await ready(alice)).toMatchObject({unread_count: 0, last_read_at: new Date(now).toISOString()});
		expect(cursorReads).toHaveBeenCalledTimes(1);
	});

	it('does not count a notification read while its job counts it (B2: one atomic step)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const postId = await post(alice, 'atomik');
		const now = fixedNow();
		vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		await like(bob, postId);
		const kv = harness.kvProvider;
		const get = kv.get.bind(kv);
		let raced = false;
		// The mark-read lands while the job reads the key's counted mark, before it raises the sequence.
		vi.spyOn(kv, 'get').mockImplementation(async (key) => {
			if (!raced && key.endsWith(':counted')) {
				raced = true;
				await ack(alice, new Date(now).toISOString()).expect(HTTP_STATUS.OK).execute();
			}
			return get(key);
		});
		await runNotificationJobs(jobs);
		expect(raced).toBe(true);
		expect(await kv.hget(unreadKey(alice), 'seq')).toBeNull();
		expect(await ready(alice)).toMatchObject({unread_count: 0, unread_seq: 0});
	});

	it('exports the read cursor and deletes it, with its KV hash, with the account (kapı Ş3, S5-T1)', async () => {
		const alice = await createTestAccount(harness);
		const aliceId = createUserID(BigInt(alice.userId));
		const readAt = new Date(Date.now() - 60_000).toISOString();
		await ack(alice, readAt).expect(HTTP_STATUS.OK).execute();
		await ready(alice);
		const feed = (await collectUserHarvestExtensions({userId: aliceId})).find((extension) => extension.name === 'feed')!
			.data as {notification_read_state: {last_read_at: string | null}};
		expect(feed.notification_read_state).toEqual({last_read_at: readAt});

		await runUserDeletionHook('feed', {userId: aliceId});
		expect(await getFeedNotificationRepository().getReadState(aliceId)).toBeNull();
		expect(await harness.kvProvider.exists(unreadKey(alice))).toBe(0);
	});
});
