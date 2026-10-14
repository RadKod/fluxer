// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {blockUser, setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {captureJobs, createPost, overrideLimits, type QueuedJob} from '@app/api/feed/tests/FeedTestUtils';
import {getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedInteractionService,
	getFeedNotificationRepository,
	getFeedNotificationService,
	getFeedRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import aggregateFeedNotification from '@app/api/worker/tasks/AggregateFeedNotification';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {
	FeedCommentResponse,
	FeedNotificationCreateEvent,
	FeedNotificationListResponse,
	FeedNotificationResponse,
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

// Runs the notification jobs queued so far the way the feed lane would, without waiting for their run_at; jobs they
// queue stay in `jobs` for the next call.
async function runNotificationJobs(jobs: Array<QueuedJob>): Promise<number> {
	let ran = 0;
	for (const job of jobs.splice(0)) {
		if (job.task !== 'aggregateFeedNotification') continue;
		await aggregateFeedNotification(job.payload, helpers);
		ran++;
	}
	return ran;
}

function notificationEvents(dispatch: {mock: {calls: Array<Array<unknown>>}}): Array<FeedNotificationResponse> {
	return dispatch.mock.calls
		.map(([params]) => params as {event: string; data: FeedNotificationResponse})
		.filter((params) => params.event === 'FEED_NOTIFICATION_CREATE')
		.map((params) => params.data);
}

describe('feed notifications', () => {
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

	const inbox = (account: TestAccount, query = '') =>
		createBuilder<FeedNotificationListResponse>(harness, account.token).get(`/feed/notifications${query}`);
	const like = (account: TestAccount, postId: string) =>
		createBuilder(harness, account.token).put(`/feed/posts/${postId}/like`).expect(HTTP_STATUS.NO_CONTENT);
	const comment = (account: TestAccount, postId: string, content: string) =>
		createBuilder<FeedCommentResponse>(harness, account.token).post(`/feed/posts/${postId}/comments`).body({content});
	const reply = (account: TestAccount, postId: string, commentId: string, content: string) =>
		createBuilder<FeedCommentResponse>(harness, account.token)
			.post(`/feed/posts/${postId}/comments/${commentId}/replies`)
			.body({content});

	it('folds 1 000 likes in one hour into one row with actor_count 1000 and pushes it at most once a minute', async () => {
		const alice = await createTestAccount(harness);
		const [bob, carol, dave] = await Promise.all([1, 2, 3].map(() => createTestAccount(harness)));
		const post = await createPost(harness, alice, {content: 'viral'}).execute();
		const row = (await getFeedRepository().getPost(BigInt(post.id)))!;
		const newAccounts = async (count: number) =>
			Promise.all(Array.from({length: count}, async () => createUserID(await getSnowflakeService().generate())));
		const strangers = await newAccounts(997);
		const now = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const jobs = captureJobs();
		const dispatch = vi.spyOn(NoopGatewayService.prototype, 'dispatchPresence');
		const service = getFeedInteractionService();

		await Promise.all(strangers.map((userId) => service.likePost(userId, row)));
		for (const account of [bob!, carol!, dave!]) {
			await service.likePost(createUserID(BigInt(account.userId)), row);
		}

		// The dirty flag queues one job for the whole burst.
		expect(jobs.filter((job) => job.task === 'aggregateFeedNotification')).toHaveLength(1);
		expect(await runNotificationJobs(jobs)).toBe(1);
		const [pushed, ...more] = notificationEvents(dispatch);
		expect(more).toEqual([]);
		expect(dispatch.mock.calls[0]![0]).toMatchObject({userId: createUserID(BigInt(alice.userId))});
		expect(pushed).toMatchObject({type: 'post_like', post_id: post.id, comment_id: null, actor_count: 1000});
		expect(pushed!.actors.map((actor) => actor.id)).toEqual([dave!.userId, carol!.userId, bob!.userId]);

		const page = await inbox(alice).execute();
		const {unread_seq: unreadSeq, unread_epoch: unreadEpoch, ...pushedRow} = pushed as FeedNotificationCreateEvent;
		expect(unreadSeq).toBe(1);
		expect(unreadEpoch).toBeGreaterThan(0);
		expect(page).toEqual([pushedRow]);
		expect(new Date(page[0]!.updated_at).toISOString()).toBe(page[0]!.updated_at);

		// Five more likes inside the same minute: the row moves, the push waits for the next minute.
		await Promise.all((await newAccounts(5)).map((userId) => service.likePost(userId, row)));
		expect(await runNotificationJobs(jobs)).toBe(1);
		expect(notificationEvents(dispatch)).toHaveLength(1);
		expect(await inbox(alice).execute()).toEqual([expect.objectContaining({id: pushed!.id, actor_count: 1005})]);

		const delivery = jobs.filter((job) => job.task === 'aggregateFeedNotification');
		expect(delivery).toHaveLength(1);
		clock.mockReturnValue(now + 61_000);
		await runNotificationJobs(delivery);
		const events = notificationEvents(dispatch);
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({id: pushed!.id, actor_count: 1005});
	});

	it('skips your own like, drops blocked accounts on read and pages newest first', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const posts = [];
		for (const content of ['bir', 'iki', 'üç']) {
			posts.push(await createPost(harness, alice, {content}).execute());
		}
		const jobs = captureJobs();

		await like(alice, posts[0]!.id).execute();
		expect(jobs).toEqual([]);

		for (const post of posts) {
			await like(bob, post.id).execute();
			await runNotificationJobs(jobs);
		}
		await like(carol, posts[2]!.id).execute();
		await runNotificationJobs(jobs);

		const first = await inbox(alice, '?limit=2').execute();
		expect(first.map((entry) => entry.post_id)).toEqual([posts[2]!.id, posts[1]!.id]);
		expect(first[0]).toMatchObject({actor_count: 2});
		expect(first[0]!.actors.map((actor) => actor.id)).toEqual([carol.userId, bob.userId]);
		const second = await inbox(alice, `?limit=2&before=${first[1]!.id}`).execute();
		expect(second.map((entry) => entry.post_id)).toEqual([posts[0]!.id]);
		expect(await inbox(alice, `?limit=2&before=${second[0]!.id}`).execute()).toEqual([]);
		// A cursor far in the future reads from the newest bucket, not every empty bucket down to it.
		const reads = vi.spyOn(getFeedNotificationRepository(), 'list');
		expect(await inbox(alice, '?limit=2&before=9223372036854775807').execute()).toEqual(first);
		expect(reads.mock.calls.length).toBeLessThanOrEqual(2);

		await blockUser(harness, alice, bob.userId);
		const afterBlock = await inbox(alice).execute();
		expect(afterBlock).toHaveLength(1);
		expect(afterBlock[0]).toMatchObject({post_id: posts[2]!.id, actor_count: 1});
		expect(afterBlock[0]!.actors.map((actor) => actor.id)).toEqual([carol.userId]);
	});

	it('notifies follows with a null post_id and comments with the newest comment id', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'yorum bekliyor'}).execute();
		const jobs = captureJobs();

		await createBuilder(harness, bob.token)
			.put(`/users/${alice.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await comment(bob, post.id, 'ilk').execute();
		const second = await comment(bob, post.id, 'ikinci').execute();
		await runNotificationJobs(jobs);

		const page = await inbox(alice).execute();
		const byType = Object.fromEntries(page.map((entry) => [entry.type, entry]));
		expect(byType.follow).toMatchObject({post_id: null, comment_id: null, actor_count: 1});
		expect(byType.follow!.actors[0]!.id).toBe(bob.userId);
		expect(byType.post_comment).toMatchObject({post_id: post.id, comment_id: second.id, actor_count: 1});

		// A deleted post takes its notifications with it on read.
		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect((await inbox(alice).execute()).map((entry) => entry.type)).toEqual(['follow']);
	});

	it('records no reply notification while the flag is 0', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'yanıtlar sessiz'}).execute();
		const top = await comment(alice, post.id, 'yorum').execute();
		const jobs = captureJobs();

		await reply(bob, post.id, top.id, 'yanıt').execute();
		await runNotificationJobs(jobs);

		expect((await inbox(alice).execute()).map((entry) => entry.type)).not.toContain('comment_reply');
	});

	it('notifies the comment author of every reply when it is 1', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 3);
		const [bob, carol, dave] = members as [TestAccount, TestAccount, TestAccount];
		const post = await createPost(harness, alice, {content: 'yanıt bildirimi'}).execute();
		const top = await comment(bob, post.id, 'bob yorumu').execute();
		overrideLimits({feature_feed_reply_notifications: 1});
		const jobs = captureJobs();
		const now = Date.now();
		const clock = vi.spyOn(Date, 'now');

		clock.mockReturnValue(now);
		await reply(carol, post.id, top.id, 'bir').execute();
		clock.mockReturnValue(now + 1000);
		await reply(dave, post.id, top.id, 'iki').execute();
		// A second reply from the same account moves the row too (as a second comment does).
		clock.mockReturnValue(now + 2000);
		await reply(carol, post.id, top.id, 'üç').execute();
		// Replying under your own comment tells nobody.
		await reply(bob, post.id, top.id, 'dört').execute();
		await runNotificationJobs(jobs);

		const replyRows = (await inbox(bob).execute()).filter((entry) => entry.type === 'comment_reply');
		expect(replyRows).toHaveLength(1);
		expect(replyRows[0]).toMatchObject({post_id: post.id, comment_id: top.id, actor_count: 2});
		expect(replyRows[0]!.actors.map((actor) => actor.id)).toEqual([carol.userId, dave.userId]);
		expect(replyRows[0]!.updated_at).toBe(new Date(now + 2000).toISOString());
		expect((await inbox(alice).execute()).map((entry) => entry.type)).not.toContain('comment_reply');
	});

	it('keeps the like when recording its notification fails', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'dayanıklı'}).execute();
		vi.spyOn(harness.kvProvider, 'hgetall').mockRejectedValue(new Error('KV unavailable'));

		await like(bob, post.id).execute();

		expect(
			await createBuilder<{like_count: number}>(harness, alice.token).get(`/feed/posts/${post.id}`).execute(),
		).toMatchObject({like_count: 1});
	});

	it('exports and deletes the inbox with the account, and answers 403 with feature_feed at 0', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const aliceId = createUserID(BigInt(alice.userId));
		const post = await createPost(harness, alice, {content: 'dışa aktar'}).execute();
		const jobs = captureJobs();
		await like(bob, post.id).execute();
		await runNotificationJobs(jobs);

		const extensions = await collectUserHarvestExtensions({userId: aliceId});
		const feed = extensions.find((extension) => extension.name === 'feed')!.data as {
			notifications: Array<Record<string, unknown>>;
		};
		expect(feed.notifications).toEqual([
			expect.objectContaining({type: 'post_like', post_id: post.id, actor_ids: [bob.userId], actor_count: 1}),
		]);

		await runUserDeletionHook('feed', {userId: aliceId});
		expect(await getFeedNotificationService().exportUserNotifications(aliceId)).toEqual([]);

		overrideLimits({feature_feed: 0});
		await inbox(bob).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
	});
});
