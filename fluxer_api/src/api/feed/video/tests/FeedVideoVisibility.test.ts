// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config, getConfig} from '@app/api/Config';
import {createFriendship} from '@app/api/channel/tests/ChannelTestUtils';
import {type FeedMedia, FeedPostFlags} from '@app/api/database/types/FeedTypes';
import {feedDiscoverCache} from '@app/api/feed/discover/FeedDiscoverCache';
import {
	captureJobs,
	followDirectly,
	overrideLimits,
	type QueuedJob,
	runFanout,
	setProfileLevel,
} from '@app/api/feed/tests/FeedTestUtils';
import {dueMinuteAt} from '@app/api/feed/video/FeedVideoRepository';
import {drainDueJobs} from '@app/api/feed/video/FeedVideoService';
import {mapFeedVideoToResponse} from '@app/api/feed/video/FeedVideoUrls';
import {getKVClient, getMediaService, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedDiscoverRepository,
	getFeedPostService,
	getFeedRepository,
	getFeedTimelineService,
	getFeedTrendService,
	getFeedVideoRepository,
	getFeedVideoService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {BUNNY_TEST_SETTINGS, fakeBunnyStream} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import processFeedVideoWebhook from '@app/api/worker/tasks/ProcessFeedVideoWebhook';
import scanFeedVideo from '@app/api/worker/tasks/ScanFeedVideo';
import type {
	FeedNotificationListResponse,
	FeedPendingVideoListResponse,
	FeedPostListResponse,
	FeedPostResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {createSnowflake} from '@fluxer/snowflake/src/Snowflake';
import type {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
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
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Video authors reach Keşfet from 7 days: planted posts are dated 8 days ahead and the list is built an hour later.
const DISCOVER_AT = Date.now() + 8 * DAY;
let sequence = 0;

async function runQueued(jobs: Array<QueuedJob>, task: string, handler: WorkerTaskHandler): Promise<number> {
	const due = jobs.filter((job) => job.task === task);
	for (const job of due) {
		jobs.splice(jobs.indexOf(job), 1);
		await handler(job.payload, helpers);
	}
	return due.length;
}

function videoMedia(guid: string, attachmentId: bigint): FeedMedia {
	return {
		attachment_id: attachmentId,
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
		stream_mp4_file: 'play_720p.mp4',
	};
}

// a video that is not a post yet reaches no API read path; once published it shows on the allowed
// paths as a `video` object with signed URLs made per viewer request, never as an attachment or in the Keşfet snapshot.
describe('feed video visibility', () => {
	let harness: ApiTestHarness;
	let kv: MockKVProvider;
	const streamDefault = Config.bunnyStream;

	async function restartCache(): Promise<void> {
		await feedDiscoverCache.shutdown();
		feedDiscoverCache.resetForTesting();
		feedDiscoverCache.setRefreshSubscriber(getKVClient());
		await feedDiscoverCache.initialize();
	}

	beforeAll(async () => {
		getConfig().bunnyStream = BUNNY_TEST_SETTINGS;
		harness = await createApiTestHarness();
		kv = harness.kvProvider as MockKVProvider;
	});

	beforeEach(async () => {
		await harness.reset();
		fakeBunnyStream.reset();
		await restartCache();
	});

	afterEach(() => {
		getConfig().bunnyStream = BUNNY_TEST_SETTINGS;
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		getConfig().bunnyStream = streamDefault;
		await feedDiscoverCache.shutdown();
		await harness?.shutdown();
	});

	const idOf = (account: TestAccount): UserID => createUserID(BigInt(account.userId));
	const get = <T>(viewer: TestAccount, path: string) => createBuilder<T>(harness, viewer.token).get(path);
	const profile = (viewer: TestAccount, author: TestAccount) =>
		get<FeedPostListResponse>(viewer, `/users/${author.userId}/posts`).execute();
	const home = (viewer: TestAccount) => get<FeedPostListResponse>(viewer, '/feed/home').execute();
	const discover = (viewer: TestAccount) => get<FeedPostListResponse>(viewer, '/feed/discover').execute();
	const single = (viewer: TestAccount, postId: string) =>
		get<FeedPostResponse>(viewer, `/feed/posts/${postId}`).execute();
	const ranked = () => kv.zrangebyscore('feed:discover:z', '-inf', '+inf');

	async function build(now: number): Promise<number> {
		await getKVClient().del('feed:discover:build');
		return getFeedTimelineService().discover.buildSnapshot(now);
	}

	// The test media service scores nothing, which the scan takes as inconclusive; a clean frame scores a little.
	function cleanFrames(): void {
		const media = getMediaService();
		const readFrame = media.getMetadata.bind(media);
		vi.spyOn(media, 'getMetadata').mockImplementation(async (request) => {
			const result = await readFrame(request);
			return result && {...result, nsfw_probability: 0.02};
		});
	}

	// A public video (its author is public).
	async function startVideo(author: TestAccount, content: string): Promise<string> {
		await setProfileLevel(author, 100);
		const user = (await getUserRepository().findUnique(idOf(author)))!;
		const ticket = await getFeedVideoService().start(user, {
			filename: 'clip.mp4',
			file_size: 1000,
			content_type: 'video/mp4',
			content,
			public: true,
		});
		return ticket.id;
	}

	// A public post row of a public author with a Bunny video, dated `at`, placed in the Keşfet ranking.
	async function plantVideoPost(
		author: TestAccount,
		at: number,
		score: number,
	): Promise<{postId: string; guid: string}> {
		await setProfileLevel(author, 100);
		const guid = randomUUID();
		const postId = createSnowflake({timestamp: at, workerId: 7, sequence: sequence++ % 4096});
		await getFeedRepository().createPost({
			post_id: postId,
			author_id: idOf(author),
			content: 'video',
			media: [videoMedia(guid, postId)],
			edited_at: null,
			flags: FeedPostFlags.PUBLIC,
			like_count: 0,
			comment_count: 0,
		});
		await getFeedDiscoverRepository().rankPost(postId, score);
		return {postId: postId.toString(), guid};
	}

	it('an unpublished video reaches no read path', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		const carol = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		await followDirectly(bob.userId, alice.userId);
		overrideLimits({feature_feed_video: 1, feature_feed_discover_media: 1, feature_feed_discover_video: 1});
		const jobs = captureJobs();
		const recordPostCreated = vi.spyOn(getFeedTrendService(), 'recordPostCreated');

		async function expectInvisible(state: string, reserved: string | null): Promise<void> {
			const row = await getFeedVideoRepository().get(guid);
			expect(row?.state).toBe(state);
			expect(row?.post_id?.toString() ?? null).toBe(reserved);
			// The author's own list of videos on their way is the one place it shows.
			const pending = await get<FeedPendingVideoListResponse>(alice, '/feed/videos').execute();
			expect(pending.map((video) => video.id)).toEqual([guid]);

			for (const viewer of [alice, bob]) {
				expect(await profile(viewer, alice)).toEqual([]);
				expect(await home(viewer)).toEqual([]);
			}
			expect(await getFeedRepository().listAuthorPostIds(idOf(alice), {limit: 10})).toEqual([]);
			expect(await getFeedRepository().getLastPost(idOf(alice))).toBeNull();
			expect(await getFeedRepository().getCelebrityRecent(idOf(alice))).toBeNull();
			expect(jobs.map((job) => job.task)).not.toContain('fanoutFeedPost');
			expect(jobs.map((job) => job.task)).not.toContain('extractFeedPostEmbeds');
			expect(await runFanout(jobs.filter((job) => job.task === 'fanoutFeedPost'))).toBe(0);
			expect(recordPostCreated).not.toHaveBeenCalled();

			if (reserved !== null) {
				expect(await getFeedRepository().getPost(BigInt(reserved))).toBeNull();
				// A stray ranking entry for the reserved ID is dropped by the build, never listed.
				await getFeedDiscoverRepository().rankPost(BigInt(reserved), 100);
				for (const viewer of [alice, bob, carol]) {
					await get(viewer, `/feed/posts/${reserved}`).expect(HTTP_STATUS.NOT_FOUND).execute();
					await get(viewer, `/feed/posts/${reserved}/comments`).expect(HTTP_STATUS.NOT_FOUND).execute();
					await get(viewer, `/feed/posts/${reserved}/likes`).expect(HTTP_STATUS.NOT_FOUND).execute();
				}
				await createBuilder(harness, bob.token)
					.put(`/feed/posts/${reserved}/like`)
					.expect(HTTP_STATUS.NOT_FOUND)
					.execute();
				await createBuilder(harness, bob.token)
					.post(`/feed/posts/${reserved}/comments`)
					.body({content: 'yorum'})
					.expect(HTTP_STATUS.NOT_FOUND)
					.execute();
				await createBuilder(harness, bob.token)
					.post('/reports/feed-post')
					.body({post_id: reserved, category: 'spam'})
					.expect(HTTP_STATUS.NOT_FOUND)
					.execute();
			}
			expect(await build(Date.now() + 25 * HOUR)).toBe(0);
			expect((await getFeedDiscoverRepository().getSnapshot())?.entries).toEqual([]);
			expect(await ranked()).toEqual([]);
			await feedDiscoverCache.refresh();
			expect(await discover(carol)).toEqual([]);
			expect(await get<FeedNotificationListResponse>(alice, '/feed/notifications').execute()).toEqual([]);
		}

		const guid = await startVideo(alice, 'yeni video https://youtu.be/dQw4w9WgXcQ');
		await expectInvisible('uploading', null);

		fakeBunnyStream.updateVideo(guid, {status: 1});
		await processFeedVideoWebhook({guid}, helpers);
		await expectInvisible('processing', null);

		await fakeBunnyStream.finishVideo(guid, {length: 20, width: 1280, height: 720});
		await processFeedVideoWebhook({guid}, helpers);
		await expectInvisible('scanning', null);

		// Every frame scores 0: inconclusive, rescheduled, still no post.
		expect(await runQueued(jobs, 'scanFeedVideo', scanFeedVideo)).toBe(1);
		await expectInvisible('scanning', null);

		// A clean scan whose publish fails after the post ID was reserved: the ID leads nowhere until it is published.
		cleanFrames();
		vi.spyOn(getFeedPostService(), 'publishPost').mockRejectedValueOnce(new Error('Cassandra timed out'));
		expect(await runQueued(jobs, 'scanFeedVideo', scanFeedVideo)).toBe(1);
		const reserved = (await getFeedVideoRepository().get(guid))!.post_id!.toString();
		await expectInvisible('scanning', reserved);

		// The next attempt waits its 5 minutes in a KV minute bucket until the minute cron hands it over; it then
		// publishes under that same ID, so the probes above were looking at the right place.
		await getFeedVideoRepository().setDueCursor(dueMinuteAt(Date.now()));
		expect(await drainDueJobs(getFeedVideoRepository(), getWorkerService(), Date.now() + HOUR)).toBe(1);
		expect(await runQueued(jobs, 'scanFeedVideo', scanFeedVideo)).toBe(1);
		expect((await single(bob, reserved)).video?.id).toBe(guid);
		expect(recordPostCreated).toHaveBeenCalledOnce();
	});

	it('after a clean scan the post shows on every allowed path with a video object and no attachment', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		await createFriendship(harness, alice, bob);
		await followDirectly(bob.userId, alice.userId);
		overrideLimits({feature_feed_video: 1});
		cleanFrames();
		const jobs = captureJobs();

		const guid = await startVideo(alice, 'ilk video');
		fakeBunnyStream.updateVideo(guid, {status: 1});
		await processFeedVideoWebhook({guid}, helpers);
		await fakeBunnyStream.finishVideo(guid, {length: 20, width: 1280, height: 720});
		await processFeedVideoWebhook({guid}, helpers);
		expect(await runQueued(jobs, 'scanFeedVideo', scanFeedVideo)).toBe(1);
		const postId = (await getFeedVideoRepository().get(guid))!.post_id!.toString();
		expect(await runFanout(jobs)).toBeGreaterThan(0);

		const expected = mapFeedVideoToResponse(
			BUNNY_TEST_SETTINGS,
			{id: guid, width: 1280, height: 720, duration: 20, mp4_file: 'play_720p.mp4'},
			Date.now(),
		);
		expect(expected.hls_url).toMatch(
			new RegExp(
				`^https://vz-test\\.b-cdn\\.test/bcdn_token=HS256-[\\w-]+&expires=\\d+&token_path=%2F${guid}%2F/${guid}/playlist\\.m3u8$`,
			),
		);
		expect(expected.poster_url).toMatch(/\/thumbnail\.jpg\?token=HS256-[\w-]+&expires=\d+$/);
		expect(expected.mp4_url).toMatch(/\/play_720p\.mp4\?token=HS256-[\w-]+&expires=\d+$/);

		const shown = [
			await single(alice, postId),
			await single(bob, postId),
			...(await profile(alice, alice)),
			...(await profile(bob, alice)),
			...(await home(alice)),
			...(await home(bob)),
		];
		expect(shown).toHaveLength(6);
		for (const post of shown) {
			expect(post).toMatchObject({id: postId, content: 'ilk video', attachments: [], video: expected});
			expect(JSON.stringify(post)).not.toContain('evidence.ts');
		}
	});

	it('gives video urls only signed and only inside a viewer response, never in the Discover snapshot', async () => {
		const alice = await createTestAccount(harness);
		const carol = await createTestAccount(harness);
		overrideLimits({feature_feed_discover_video: 1});
		const {postId, guid} = await plantVideoPost(alice, DISCOVER_AT - HOUR, 10);

		expect(await build(DISCOVER_AT)).toBe(1);
		const snapshot = (await getFeedDiscoverRepository().getSnapshot())!;
		expect(snapshot.entries.map((entry) => entry.post.id)).toEqual([postId]);
		expect(snapshot.entries[0]!.post).toMatchObject({
			attachments: [],
			video: {id: guid, width: 1280, height: 720, duration: 20, mp4_file: 'play_720p.mp4'},
		});
		const stored = JSON.stringify(snapshot);
		for (const secret of ['token', BUNNY_TEST_SETTINGS.cdnHostname, 'https://', 'evidence.ts']) {
			expect(stored).not.toContain(secret);
		}

		await feedDiscoverCache.refresh();
		const expected = mapFeedVideoToResponse(BUNNY_TEST_SETTINGS, snapshot.entries[0]!.post.video!, Date.now());
		const [listed] = await discover(carol);
		expect(listed).toMatchObject({id: postId, attachments: [], video: expected});
		expect((await single(carol, postId)).video).toEqual(expected);

		// Without full Bunny Stream settings there is nothing to sign with, and no unsigned fallback either.
		getConfig().bunnyStream = {...BUNNY_TEST_SETTINGS, enabled: false, tokenKey: ''};
		for (const post of [(await discover(carol))[0]!, await single(carol, postId)]) {
			expect(post).toMatchObject({id: postId, attachments: []});
			expect(post.video).toBeUndefined();
			expect(JSON.stringify(post)).not.toContain(guid);
		}
	});

	it('Discover takes a public video post only while feature_feed_discover_video is 1', async () => {
		const alice = await createTestAccount(harness);
		const {postId: video} = await plantVideoPost(alice, DISCOVER_AT - HOUR, 3);
		const imageId = createSnowflake({timestamp: DISCOVER_AT - HOUR, workerId: 7, sequence: sequence++ % 4096});
		await getFeedRepository().createPost({
			post_id: imageId,
			author_id: idOf(alice),
			content: 'resim',
			media: [
				{
					attachment_id: imageId,
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
				},
			],
			edited_at: null,
			flags: FeedPostFlags.PUBLIC,
			like_count: 0,
			comment_count: 0,
		});
		await getFeedDiscoverRepository().rankPost(imageId, 2);
		const image = imageId.toString();
		const snapshotIds = async () =>
			(await getFeedDiscoverRepository().getSnapshot())!.entries.map((entry) => entry.post.id);

		// Images allowed, video not: the video waits in the ranking.
		overrideLimits({feature_feed_discover_media: 1});
		await build(DISCOVER_AT);
		expect(await snapshotIds()).toEqual([image]);
		expect(await ranked()).toContain(video);

		// Video allowed, images not: the video goes in on its own flag.
		vi.restoreAllMocks();
		overrideLimits({feature_feed_discover_video: 1});
		await build(DISCOVER_AT);
		expect(await snapshotIds()).toEqual([video]);
		expect(await ranked()).toContain(image);
	});
});
