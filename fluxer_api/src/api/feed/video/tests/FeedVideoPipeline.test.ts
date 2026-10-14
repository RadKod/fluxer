// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, userIdToChannelId} from '@app/api/BrandedTypes';
import {Config, getConfig} from '@app/api/Config';
import {loadFixture} from '@app/api/channel/tests/AttachmentTestUtils';
import type {FeedMedia, FeedPostRow} from '@app/api/database/types/FeedTypes';
import {feedDay} from '@app/api/feed/FeedRepository';
import {
	captureJobs,
	createPost,
	followDirectly,
	overrideLimits,
	type QueuedJob,
	runFanout,
} from '@app/api/feed/tests/FeedTestUtils';
import {feedStreamEvidenceKey, streamPlaylistUrl} from '@app/api/feed/video/FeedVideoUrls';
import {getMediaService, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedPostService,
	getFeedRepository,
	getFeedTrendService,
	getFeedVideoRepository,
	getFeedVideoService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import type {User} from '@app/api/models/User';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {BUNNY_TEST_SETTINGS, fakeBunnyStream} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {NoopWorkerService} from '@app/api/test/NoopWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import type {CronScheduler} from '@app/api/worker/CronScheduler';
import {JOBS_STREAM_MAX_AGE_MS} from '@app/api/worker/JetStreamWorkerQueue';
import deleteFeedVideo from '@app/api/worker/tasks/DeleteFeedVideo';
import processFeedVideoWebhook from '@app/api/worker/tasks/ProcessFeedVideoWebhook';
import scanFeedVideo from '@app/api/worker/tasks/ScanFeedVideo';
import {registerCronJobs} from '@app/api/worker/WorkerMain';
import type {ClientUploadedAttachmentRequest} from '@fluxer/schema/src/domains/message/AttachmentSchemas';
import type {PresignedAttachmentUploadResponse} from '@fluxer/schema/src/domains/message/AttachmentUploadSchemas';
import type {WorkerTaskHandler, WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};
const SEVEN_DAYS_S = 7 * 24 * 3600;

// Runs the queued jobs of one task the way the video lane would, taking them off the list.
async function runQueued(jobs: Array<QueuedJob>, task: string, handler: WorkerTaskHandler): Promise<number> {
	const due = jobs.filter((job) => job.task === task);
	for (const job of due) {
		jobs.splice(jobs.indexOf(job), 1);
		await handler(job.payload, helpers);
	}
	return due.length;
}

function queuedWith(task: string): Array<Array<unknown>> {
	const calls = vi.mocked(NoopWorkerService.prototype.addJob).mock.calls as Array<Array<unknown>>;
	return calls.filter((call) => call[0] === task);
}

describe('feed video pipeline', () => {
	let harness: ApiTestHarness;
	const streamDefault = Config.bunnyStream;
	const presignedDefault = Config.presignedAttachmentUploadsEnabled;

	beforeAll(async () => {
		getConfig().bunnyStream = BUNNY_TEST_SETTINGS;
		getConfig().presignedAttachmentUploadsEnabled = true;
		harness = await createApiTestHarness();
	});

	beforeEach(() => {
		fakeBunnyStream.reset();
	});

	afterEach(() => {
		getConfig().bunnyStream = BUNNY_TEST_SETTINGS;
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		getConfig().bunnyStream = streamDefault;
		getConfig().presignedAttachmentUploadsEnabled = presignedDefault;
		await harness?.shutdown();
	});

	async function findUser(account: TestAccount): Promise<User> {
		return (await getUserRepository().findUnique(createUserID(BigInt(account.userId))))!;
	}

	async function homePostIds(account: TestAccount, postId: bigint): Promise<Array<string>> {
		const rows = await getFeedRepository().listHome(
			createUserID(BigInt(account.userId)),
			feedDay(postId),
			undefined,
			10,
		);
		return rows.map((row) => row.post_id.toString());
	}

	async function uploadImage(account: TestAccount): Promise<ClientUploadedAttachmentRequest> {
		const data = loadFixture('yeah.png');
		const {attachments} = await createBuilder<PresignedAttachmentUploadResponse>(harness, account.token)
			.post('/feed/attachments')
			.body({attachments: [{id: 1, filename: 'photo.png', file_size: data.length, content_type: 'image/png'}]})
			.execute();
		const planned = attachments[0]!;
		await harness.storageService.uploadObject({
			bucket: Config.s3.buckets.uploads,
			key: planned.upload_filename,
			body: data,
			contentType: 'image/png',
		});
		return {
			id: 0,
			filename: 'photo.png',
			upload_filename: planned.upload_filename,
			file_size: data.length,
			content_type: 'image/png',
			flags: 0,
		};
	}

	// A published video post as the scan would write it.
	async function publishVideoPost(author: User): Promise<{post: FeedPostRow; media: FeedMedia; guid: string}> {
		const guid = randomUUID();
		const postId = await getSnowflakeService().generate();
		const media: FeedMedia = {
			attachment_id: postId,
			filename: 'evidence.ts',
			size: 1000n,
			description: null,
			width: 1280,
			height: 720,
			content_type: 'video/mp2t',
			content_hash: null,
			placeholder: null,
			flags: 0,
			nsfw: false,
			duration: 20,
			stream_video_id: guid,
			stream_mp4_file: null,
		};
		const post: FeedPostRow = {
			post_id: postId,
			author_id: author.id,
			content: 'video',
			media: [media],
			edited_at: null,
			flags: 0,
			like_count: 0,
			comment_count: 0,
		};
		await getFeedPostService().publishPost(author, post, 1);
		return {post, media, guid};
	}

	async function startVideo(author: User): Promise<string> {
		const ticket = await getFeedVideoService().start(author, {
			filename: 'clip.mp4',
			file_size: 1000,
			content_type: 'video/mp4',
			content: 'ilk video',
			public: false,
		});
		return ticket.id;
	}

	it('a posted image post still behaves exactly as before (publishPost split)', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await followDirectly(bob.userId, alice.userId);
		const aliceId = createUserID(BigInt(alice.userId));
		const attachment = await uploadImage(alice);
		const jobs = captureJobs();
		const recordPostCreated = vi.spyOn(getFeedTrendService(), 'recordPostCreated');

		const post = await createPost(harness, alice, {
			content: 'bak https://youtu.be/dQw4w9WgXcQ',
			attachments: [attachment],
		}).execute();

		expect(post.attachments).toMatchObject([{filename: 'photo.png', content_type: 'image/png'}]);
		expect(await getFeedRepository().getLastPost(aliceId)).toBe(BigInt(post.id));
		expect(recordPostCreated).toHaveBeenCalledOnce();
		expect(jobs.filter((job) => job.task === 'extractFeedPostEmbeds')).toEqual([
			{task: 'extractFeedPostEmbeds', payload: {postId: post.id}},
		]);
		expect(await runFanout(jobs)).toBeGreaterThan(0);
		expect(await homePostIds(bob, BigInt(post.id))).toEqual([post.id]);

		const cdnKey = `attachments/${userIdToChannelId(aliceId)}/${post.attachments[0]!.id}/photo.png`;
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, cdnKey)).not.toBeNull();
		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, cdnKey)).toBeNull();
		expect(jobs.map((job) => job.task)).not.toContain('deleteFeedVideo');
	});

	it('a webhook to publish run puts the post in followers’ home feeds through the fan-out', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await followDirectly(bob.userId, alice.userId);
		overrideLimits({feature_feed_video: 1});
		const media = getMediaService();
		const readFrame = media.getMetadata.bind(media);
		// The test media service scores nothing; a clean frame has a small non-zero NSFW probability.
		vi.spyOn(media, 'getMetadata').mockImplementation(async (request) => {
			const result = await readFrame(request);
			return result && {...result, nsfw_probability: 0.02};
		});
		const jobs = captureJobs();

		const guid = await startVideo(await findUser(alice));
		fakeBunnyStream.updateVideo(guid, {status: 1});
		await processFeedVideoWebhook({guid}, helpers);
		await fakeBunnyStream.finishVideo(guid, {length: 20});
		await processFeedVideoWebhook({guid}, helpers);
		expect(await runQueued(jobs, 'scanFeedVideo', scanFeedVideo)).toBe(1);

		const row = await getFeedVideoRepository().get(guid);
		expect(row?.state).toBe('published');
		expect(await getFeedRepository().getPost(row!.post_id!)).toMatchObject({content: 'ilk video'});
		expect(await homePostIds(bob, row!.post_id!)).toEqual([]);
		expect(await runFanout(jobs)).toBeGreaterThan(0);
		expect(await homePostIds(bob, row!.post_id!)).toEqual([row!.post_id!.toString()]);
	});

	it('deleting a video post queues deleteFeedVideo with no evidence', async () => {
		const alice = await createTestAccount(harness);
		const {post, guid} = await publishVideoPost(await findUser(alice));
		captureJobs();

		await createBuilder(harness, alice.token)
			.delete(`/feed/posts/${post.post_id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(queuedWith('deleteFeedVideo')).toEqual([['deleteFeedVideo', {guid}, {jobKey: `feed-video-delete:${guid}`}]]);
		expect(await getFeedRepository().getPost(post.post_id)).toBeNull();
	});

	it('a moderator-priority removal queues it with the evidence key', async () => {
		const author = await findUser(await createTestAccount(harness));
		const {post, media, guid} = await publishVideoPost(author);
		captureJobs();

		await getFeedPostService().removePost(post, {priority: true});

		expect(queuedWith('deleteFeedVideo')).toEqual([
			[
				'deleteFeedVideo',
				{guid, priority: true, evidence: feedStreamEvidenceKey(author.id, media)},
				{jobKey: `feed-video-delete:${guid}`},
			],
		]);
	});

	it('account deletion removes in-flight videos from Bunny', async () => {
		const alice = await createTestAccount(harness);
		const author = await findUser(alice);
		overrideLimits({feature_feed_video: 1});
		const jobs = captureJobs();
		const guid = await startVideo(author);
		expect(fakeBunnyStream.getVideo(guid)).not.toBeNull();

		await runUserDeletionHook('feed', {userId: author.id});
		expect(await runQueued(jobs, 'deleteFeedVideo', deleteFeedVideo)).toBe(1);

		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
		expect(await getFeedVideoRepository().get(guid)).toBeNull();
		expect(await getFeedVideoRepository().listByAuthor(author.id, 10)).toEqual([]);
	});

	it('the data export gives a video post a signed HLS playlist url valid for 7 days', async () => {
		const author = await findUser(await createTestAccount(harness));
		const {post, guid} = await publishVideoPost(author);
		const now = Math.floor(Date.now() / 1000);

		const feedExport = (await collectUserHarvestExtensions({userId: author.id})).find((entry) => entry.name === 'feed');
		const exported = (feedExport!.data as {posts: Array<{id: string; attachments: Array<{url: string}>}>}).posts;

		expect(exported).toHaveLength(1);
		expect(exported[0]!.id).toBe(post.post_id.toString());
		const [attachment] = exported[0]!.attachments;
		const expires = Number(/[&?]expires=(\d+)/.exec(attachment!.url)?.[1]);
		expect(expires - now).toBeGreaterThanOrEqual(SEVEN_DAYS_S - 5);
		expect(expires - now).toBeLessThanOrEqual(SEVEN_DAYS_S + 5);
		expect(attachment).toEqual({
			id: post.post_id.toString(),
			filename: 'playlist.m3u8',
			content_type: 'application/vnd.apple.mpegurl',
			size: null,
			url: streamPlaylistUrl(BUNNY_TEST_SETTINGS, guid, expires),
		});
	});

	it('the reconcile and due job crons are registered only when Bunny Stream is enabled', () => {
		function videoCrons(): Array<Array<unknown>> {
			const cron = {upsert: vi.fn()};
			registerCronJobs(cron as unknown as CronScheduler, JOBS_STREAM_MAX_AGE_MS);
			return cron.upsert.mock.calls.filter((call) => ['reconcileFeedVideos', 'drainFeedVideoJobs'].includes(call[0]));
		}

		getConfig().bunnyStream = {...BUNNY_TEST_SETTINGS, enabled: false, tokenKey: '', storagePassword: ''};
		expect(videoCrons()).toEqual([]);
		getConfig().bunnyStream = BUNNY_TEST_SETTINGS;
		expect(videoCrons()).toEqual([
			['reconcileFeedVideos', 'reconcileFeedVideos', {}, '0 7 * * * *', {ledger: false}],
			['drainFeedVideoJobs', 'drainFeedVideoJobs', {}, '30 * * * * *', {ledger: false}],
		]);
	});
});
