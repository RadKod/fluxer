// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHmac} from 'node:crypto';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {createDefaultLimitConfig} from '@app/api/constants/LimitConfig';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {feedDay} from '@app/api/feed/FeedRepository';
import {BunnyStreamClient} from '@app/api/feed/video/BunnyStreamClient';
import {FeedVideoRepository, pendingHour, pendingHourAt, pendingShard} from '@app/api/feed/video/FeedVideoRepository';
import {FeedVideoScanner, parseMasterPlaylist, parseMediaPlaylist} from '@app/api/feed/video/FeedVideoScanner';
import {
	deferLongWaits,
	drainDueJobs,
	type FeedVideoDmKey,
	type FeedVideoJobName,
	FeedVideoService,
} from '@app/api/feed/video/FeedVideoService';
import {
	feedStreamEvidenceKey,
	feedVideoBaseOf,
	mapFeedVideoToResponse,
	signTusUpload,
} from '@app/api/feed/video/FeedVideoUrls';
import type {MediaProxyMetadataRequest, MediaProxyMetadataResponse} from '@app/api/infrastructure/IMediaService';
import {Logger} from '@app/api/Logger';
import {User} from '@app/api/models/User';
import {MockKVProvider} from '@app/api/test/mocks/MockKVProvider';
import {MockStorageService} from '@app/api/test/mocks/MockStorageService';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {
	BUNNY_TEST_SETTINGS,
	type FinishVideoOptions,
	fakeBunnyStream,
} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {UnauthorizedError} from '@fluxer/errors/src/domains/core/UnauthorizedError';
import {createSnowflakeFromTimestamp, snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import sharp from 'sharp';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const settings = BUNNY_TEST_SETTINGS;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// Each test starts 200 h after the last, far from the real clock, so no test shares a pending partition or checkpoint.
const BASE = Date.UTC(2031, 0, 6, 12, 0, 0);
let run = 0;
let T0 = BASE;
const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 360, 360, 1440, 1440];
let nextAuthor = 7_000_000n;

interface QueuedJob {
	task: FeedVideoJobName;
	payload: Record<string, unknown>;
	options: {jobKey?: string; runAt?: Date} | undefined;
}

type FrameAnswer = (name: string) => Promise<Partial<MediaProxyMetadataResponse> | null>;

// Thumbnails in the fake Bunny library are coloured; the NSFW answers pick frames by colour.
const COLOURS: Record<string, [number, number, number]> = {
	poster: [192, 48, 48],
	thumbnail_1: [48, 192, 48],
	thumbnail_2: [48, 48, 192],
	thumbnail_3: [192, 192, 48],
	thumbnail_4: [48, 192, 192],
	thumbnail_5: [192, 48, 192],
	tile: [128, 128, 128],
};

async function frameName(base64: string): Promise<string> {
	const {channels} = await sharp(Buffer.from(base64, 'base64')).stats();
	const rgb = channels.slice(0, 3).map((channel) => channel.mean);
	return Object.entries(COLOURS).sort(
		([, a], [, b]) =>
			a.reduce((sum, value, index) => sum + (value - rgb[index]!) ** 2, 0) -
			b.reduce((sum, value, index) => sum + (value - rgb[index]!) ** 2, 0),
	)[0]![0];
}

function snapshotOf(limits: {video: boolean; feed: boolean}) {
	const base = createDefaultLimitConfig({selfHosted: false});
	const rule = {...(limits.video ? {feature_feed_video: 1} : {}), ...(limits.feed ? {} : {feature_feed: 0})};
	return {...base, rules: [...base.rules, {id: 'test_feed_video', limits: rule}]};
}

function createHarness(options: {answer?: FrameAnswer} = {}) {
	const kv = new MockKVProvider();
	const repository = new FeedVideoRepository(kv);
	const client = new BunnyStreamClient(settings);
	const answer = options.answer ?? (async () => ({}));
	const getMetadata = vi.fn(async (request: MediaProxyMetadataRequest) => {
		const verdict = await answer(request.type === 'base64' ? await frameName(request.base64) : 'url');
		if (verdict === null) return null;
		return {
			format: 'jpeg',
			content_type: 'image/jpeg',
			content_hash: 'hash',
			size: 1,
			nsfw: false,
			nsfw_probability: 0.02,
			...verdict,
		} satisfies MediaProxyMetadataResponse;
	});
	const scanner = new FeedVideoScanner({client, media: {getMetadata}, randomInt: () => 0});
	const jobs: Array<QueuedJob> = [];
	const queue = {failing: false};
	const worker = {
		addJob: vi.fn(
			async (task: FeedVideoJobName, payload: Record<string, unknown>, jobOptions?: QueuedJob['options']) => {
				if (queue.failing) throw new Error('queue down');
				jobs.push({task, payload, options: jobOptions});
				return 0n;
			},
		),
	};
	const posts = new Map<bigint, FeedPostRow>();
	const published: Array<{post: FeedPostRow; postedToday: number; rowPostId: bigint | null | undefined}> = [];
	const removed: Array<{post: FeedPostRow; priority: boolean | undefined}> = [];
	const daily = new Map<string, number>();
	const authorId = createUserID(nextAuthor++);
	const author = new User({...EMPTY_USER_ROW, user_id: authorId, username: 'author', discriminator: 1, version: 1});
	const stranger = new User({
		...EMPTY_USER_ROW,
		user_id: createUserID(nextAuthor++),
		username: 'stranger',
		discriminator: 2,
		version: 1,
	});
	const users = new Map([
		[author.id, author],
		[stranger.id, stranger],
	]);
	const storage = new MockStorageService();
	// feature_feed_video and feature_feed for the author: on unless a test turns them off.
	const limits = {video: true, feed: true};
	const findUser = vi.fn(async (id: UserID) => users.get(id) ?? null);
	const purged: Array<{urls: Array<string>; priority: boolean}> = [];
	const dms: Array<{authorId: UserID; key: FeedVideoDmKey}> = [];
	let sequence = 0n;
	const publisher = {
		publishPost: vi.fn(async (_author: User, post: FeedPostRow, postedToday: number) => {
			const row = await repository.get(post.media![0]!.stream_video_id!);
			published.push({post, postedToday, rowPostId: row?.post_id});
			posts.set(post.post_id, post);
		}),
		removePost: vi.fn(async (post: FeedPostRow, removal: {priority?: boolean}) => {
			removed.push({post, priority: removal.priority});
			posts.delete(post.post_id);
		}),
	};
	const service = new FeedVideoService({
		repository,
		client,
		scanner,
		settings: () => settings,
		posts: publisher,
		feedRepository: {
			countPostsToday: async (id, day) => daily.get(`${id}:${day}`) ?? 0,
			addPostToday: async (id, day) => {
				const count = (daily.get(`${id}:${day}`) ?? 0) + 1;
				daily.set(`${id}:${day}`, count);
				return count;
			},
			getPost: async (postId) => posts.get(postId) ?? null,
		},
		worker,
		snowflake: {generate: async () => createSnowflakeFromTimestamp(Date.now()) + ++sequence},
		limits: {
			getConfigSnapshot: () => snapshotOf(limits),
		},
		users: {findUnique: findUser},
		storage,
		purgeQueue: {
			addUrls: async (urls, purge) => {
				purged.push({urls, priority: purge?.priority ?? false});
			},
		},
		notifyAuthor: async (id, key) => {
			dms.push({authorId: id, key});
		},
	});

	function take(task: FeedVideoJobName): Array<QueuedJob> {
		const taken = jobs.filter((job) => job.task === task);
		for (const job of taken) jobs.splice(jobs.indexOf(job), 1);
		return taken;
	}

	async function start(content: string | null = 'hello'): Promise<string> {
		const ticket = await service.start(author, {
			filename: 'clip.mp4',
			file_size: 1000,
			content_type: 'video/mp4',
			content,
			public: true,
		});
		return ticket.id;
	}

	async function toScanning(finish: FinishVideoOptions = {}): Promise<string> {
		const guid = await start();
		fakeBunnyStream.updateVideo(guid, {status: 1});
		await service.handleWebhook(guid);
		await fakeBunnyStream.finishVideo(guid, {length: 20, ...finish});
		await service.handleWebhook(guid);
		take('scanFeedVideo');
		return guid;
	}

	async function publish(finish: FinishVideoOptions = {}): Promise<{guid: string; post: FeedPostRow}> {
		const guid = await toScanning(finish);
		await service.scan(guid, 0);
		const row = await repository.get(guid);
		expect(row?.state).toBe('published');
		return {guid, post: posts.get(row!.post_id!)!};
	}

	function apiReads(guid: string): number {
		return fakeBunnyStream
			.getCalls()
			.filter((call) => call.service === 'api' && call.method === 'GET' && call.guid === guid).length;
	}

	return {
		kv,
		repository,
		service,
		jobs,
		queue,
		take,
		start,
		toScanning,
		publish,
		apiReads,
		getMetadata,
		published,
		removed,
		posts,
		daily,
		author,
		stranger,
		users,
		storage,
		purged,
		dms,
		worker,
		limits,
		findUser,
	};
}

function minutesFromNow(job: QueuedJob): number {
	return (job.options!.runAt!.getTime() - Date.now()) / MINUTE;
}

function signedWebhook(body: object) {
	const raw = JSON.stringify(body);
	return {
		raw,
		headers: {
			signature: createHmac('sha256', settings.readOnlyApiKey).update(raw).digest('hex'),
			version: 'v1',
			algorithm: 'hmac-sha256',
		},
	};
}

function warnings() {
	return vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'warn');
}

describe('FeedVideoService', () => {
	beforeEach(() => {
		T0 = BASE + run++ * 200 * HOUR;
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(T0);
		fakeBunnyStream.reset();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('starts an upload: Bunny video, rows, signature, one daily post counted', async () => {
		const h = createHarness();
		const ticket = await h.service.start(h.author, {
			filename: 'clip.mp4',
			file_size: 1000,
			content_type: 'video/mp4',
			content: 'hello',
			public: true,
		});
		const expires = Math.floor(T0 / 1000) + 2 * 3600;
		expect(ticket).toEqual({
			id: ticket.id,
			library_id: String(settings.libraryId),
			upload: {endpoint: settings.tusEndpoint, signature: signTusUpload(settings, ticket.id, expires), expires},
		});
		expect(JSON.stringify(ticket)).not.toContain(settings.apiKey);

		const row = (await h.repository.get(ticket.id))!;
		expect(row).toMatchObject({
			author_id: h.author.id,
			state: 'uploading',
			content: 'hello',
			flags: 1,
			content_type: 'video/mp4',
			declared_size: 1000n,
			post_id: null,
		});
		expect(fakeBunnyStream.getVideo(ticket.id)?.title).toBe(row.created_id.toString());
		expect((await h.repository.listByAuthor(h.author.id, 10)).map((video) => video.video_guid)).toEqual([ticket.id]);
		expect(await h.repository.listPending(pendingHour(row.created_id), pendingShard(ticket.id), null, 10)).toContain(
			ticket.id,
		);
		expect(h.daily.get(`${h.author.id}:${feedDay(row.created_id)}`)).toBe(1);
		expect(await h.service.listPending(h.author)).toEqual([
			{id: ticket.id, state: 'uploading', created_at: snowflakeToDate(row.created_id).toISOString(), post_id: null},
		]);
		expect(await h.service.listPending(h.stranger)).toEqual([]);
	});

	it('refuses a fourth video in flight', async () => {
		const h = createHarness();
		for (let index = 0; index < 3; index++) await h.start();
		await expect(h.start()).rejects.toBeInstanceOf(RateLimitError);
		expect(fakeBunnyStream.getCalls().filter((call) => call.method === 'POST')).toHaveLength(3);
	});

	it('re-signs only while uploading and within 6 hours', async () => {
		const h = createHarness();
		const guid = await h.start();
		vi.setSystemTime(T0 + HOUR);
		const ticket = await h.service.resign(h.author, guid);
		const expires = Math.floor((T0 + HOUR) / 1000) + 2 * 3600;
		expect(ticket.upload).toEqual({
			endpoint: settings.tusEndpoint,
			signature: signTusUpload(settings, guid, expires),
			expires,
		});
		await expect(h.service.resign(h.stranger, guid)).rejects.toBeInstanceOf(NotFoundError);

		const token = await h.repository.lockVideo(guid);
		await expect(h.service.resign(h.author, guid)).rejects.toBeInstanceOf(ConflictError);
		await h.repository.unlockVideo(guid, token!);

		vi.setSystemTime(T0 + 6 * HOUR);
		await expect(h.service.resign(h.author, guid)).rejects.toBeInstanceOf(NotFoundError);

		vi.setSystemTime(T0);
		const processing = await h.start();
		fakeBunnyStream.updateVideo(processing, {status: 1});
		await h.service.handleWebhook(processing);
		await expect(h.service.resign(h.author, processing)).rejects.toBeInstanceOf(NotFoundError);
	});

	it('releases the webhook claim when queueing fails', async () => {
		const h = createHarness();
		const guid = await h.start();
		const hook = signedWebhook({VideoLibraryId: settings.libraryId, VideoGuid: guid, Status: 3});
		h.queue.failing = true;
		await expect(h.service.acceptWebhook(hook.raw, hook.headers)).rejects.toThrow('queue down');
		h.queue.failing = false;
		await h.service.acceptWebhook(hook.raw, hook.headers);
		await h.service.acceptWebhook(hook.raw, hook.headers);
		expect(h.take('processFeedVideoWebhook')).toEqual([
			{task: 'processFeedVideoWebhook', payload: {guid}, options: {jobKey: `${guid}:3`}},
		]);

		await expect(
			h.service.acceptWebhook(hook.raw, {...hook.headers, signature: '0'.repeat(64)}),
		).rejects.toBeInstanceOf(UnauthorizedError);
		const other = signedWebhook({VideoLibraryId: 1, VideoGuid: guid, Status: 4});
		await h.service.acceptWebhook(other.raw, other.headers);
		const unknown = signedWebhook({VideoLibraryId: settings.libraryId, VideoGuid: guid, Status: 99});
		await h.service.acceptWebhook(unknown.raw, unknown.headers);
		expect(h.jobs).toEqual([]);
	});

	it('moves to processing and queues the scan once Finished', async () => {
		const h = createHarness();
		const guid = await h.start();
		fakeBunnyStream.updateVideo(guid, {status: 1});
		await h.service.handleWebhook(guid);
		expect((await h.repository.get(guid))?.state).toBe('processing');
		expect(h.take('scanFeedVideo')).toEqual([]);

		vi.setSystemTime(T0 + 5 * MINUTE);
		await fakeBunnyStream.finishVideo(guid, {length: 20});
		await h.service.handleWebhook(guid);
		await h.service.handleWebhook(guid);
		const row = (await h.repository.get(guid))!;
		expect(row.state).toBe('scanning');
		expect(row.scan_started_at?.getTime()).toBe(T0 + 5 * MINUTE);
		expect(h.take('scanFeedVideo')).toEqual([
			{task: 'scanFeedVideo', payload: {guid, attempt: 0}, options: {jobKey: `scan:${guid}:${T0 + 5 * MINUTE}:0`}},
		]);
	});

	it('rejects at the first webhook a video whose listed original is over 500 MB and records the real size otherwise', async () => {
		const h = createHarness();
		const large = await h.start();
		fakeBunnyStream.setFile(large, 'original', Buffer.from('x'), 524_288_001);
		fakeBunnyStream.updateVideo(large, {status: 1});
		await h.service.handleWebhook(large);
		const rejected = (await h.repository.get(large))!;
		expect(rejected).toMatchObject({state: 'deleting', content: null});
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_too_large'}]);
		expect(h.take('deleteFeedVideo')).toEqual([
			{task: 'deleteFeedVideo', payload: {guid: large}, options: {jobKey: `feed-video-delete:${large}`}},
		]);
		expect(await h.repository.listByAuthor(h.author.id, 10)).toEqual([]);
		expect(
			await h.repository.listPending(pendingHour(rejected.created_id), pendingShard(large), null, 10),
		).not.toContain(large);

		const fits = await h.start();
		fakeBunnyStream.setFile(fits, 'original', Buffer.from('x'), 400_000_000);
		fakeBunnyStream.updateVideo(fits, {status: 2});
		await h.service.handleWebhook(fits);
		expect(await h.repository.get(fits)).toMatchObject({state: 'processing', declared_size: 400_000_000n});
	});

	it('passes on the declared size with a warning when the original is no longer listed', async () => {
		const h = createHarness();
		const warn = warnings();
		const guid = await h.start();
		fakeBunnyStream.updateVideo(guid, {status: 1});
		await h.service.handleWebhook(guid);
		expect(await h.repository.get(guid)).toMatchObject({state: 'processing', declared_size: 1000n});
		expect(warn).toHaveBeenCalledWith({guid}, 'Feed video original was not listed at the first webhook');
	});

	it('publishes a Finished video without MP4 files with mp4_url null', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish({mp4: []});
		const media = post.media![0]!;
		expect(media.stream_mp4_file).toBeNull();
		expect((await h.repository.get(guid))?.mp4_file).toBeNull();
		expect(mapFeedVideoToResponse(settings, feedVideoBaseOf(media), Date.now()).mp4_url).toBeNull();

		const withMp4 = await h.publish({mp4: ['play_360p.mp4', 'play_480p.mp4', 'play_1080p.mp4']});
		expect(withMp4.post.media![0]!.stream_mp4_file).toBe('play_480p.mp4');
	});

	it('publishes only after Finished and a clean scan, with the post id reserved first', async () => {
		const h = createHarness();
		const guid = await h.start();
		fakeBunnyStream.updateVideo(guid, {status: 1});
		await h.service.handleWebhook(guid);
		await h.service.scan(guid, 0);
		expect(h.published).toEqual([]);

		vi.setSystemTime(T0 + 10 * MINUTE);
		await fakeBunnyStream.finishVideo(guid, {length: 20, width: 3840, height: 2160, rotation: -90});
		await h.service.handleWebhook(guid);
		await h.service.scan(guid, 0);
		expect(h.published).toHaveLength(1);
		const [{post, postedToday, rowPostId}] = h.published as [(typeof h.published)[number]];
		expect(rowPostId).toBe(post.post_id);
		expect(postedToday).toBe(1);
		expect(post).toMatchObject({author_id: h.author.id, content: 'hello', flags: 1, like_count: 0, comment_count: 0});
		expect(post.media![0]).toMatchObject({width: 2160, height: 3840, duration: 20, stream_video_id: guid});
		const bunny = fakeBunnyStream.getVideo(guid)!;
		expect(await h.repository.get(guid)).toMatchObject({
			state: 'published',
			content: null,
			post_id: post.post_id,
			uploaded_at: bunny.dateUploaded,
			original_hash: bunny.originalHash,
			mp4_file: 'play_720p.mp4',
			width: 2160,
			height: 3840,
			duration: 20,
		});
	});

	it('does not publish twice when the scan job runs twice', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		await Promise.all([h.service.scan(guid, 0), h.service.scan(guid, 0)]);
		vi.setSystemTime(T0 + 10 * MINUTE);
		await h.service.scan(guid, 0);
		await h.service.scan(guid, 1);
		expect(h.published).toHaveLength(1);
		expect(h.posts.size).toBe(1);
	});

	it('waits for content tagging without reading any frame and scans once 30 minutes have passed', async () => {
		const h = createHarness();
		const guid = await h.toScanning({category: 'untagged'});
		const startedAt = (await h.repository.get(guid))!.scan_started_at!;
		const before = fakeBunnyStream.getCalls().length;
		await h.service.scan(guid, 0);
		await h.service.scan(guid, 1);
		const reads = fakeBunnyStream
			.getCalls()
			.slice(before)
			.filter((call) => call.service === 'storage' && /\.jpg$/.test(call.path));
		expect(reads).toEqual([]);
		expect(h.getMetadata).not.toHaveBeenCalled();
		expect(h.take('scanFeedVideo')).toEqual([
			{
				task: 'scanFeedVideo',
				payload: {guid, attempt: 1},
				options: {
					runAt: new Date(startedAt.getTime() + 30 * MINUTE),
					jobKey: `scan:${guid}:${startedAt.getTime()}:tag`,
				},
			},
		]);

		vi.setSystemTime(startedAt.getTime() + 30 * MINUTE);
		await h.service.scan(guid, 1);
		expect(h.getMetadata).toHaveBeenCalled();
		expect((await h.repository.get(guid))?.state).toBe('published');
	});

	it('fails a video with a layout failure at once without retrying', async () => {
		const h = createHarness();
		const guid = await h.toScanning({length: 90, sheet: {width: 1799, height: 3198}});
		await h.service.scan(guid, 0);
		expect(await h.repository.get(guid)).toMatchObject({state: 'deleting', content: null});
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_failed'}]);
		expect(h.take('scanFeedVideo')).toEqual([]);
		expect(h.take('deleteFeedVideo')).toHaveLength(1);
		expect(h.published).toEqual([]);
	});

	it('drops the video of a disabled author without a post or a DM', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		h.users.set(h.author.id, new User({...h.author.toRow(), flags: UserFlags.DISABLED}));
		await h.service.scan(guid, 0);
		expect(h.published).toEqual([]);
		expect(await h.repository.get(guid)).toMatchObject({state: 'deleting', content: null});
		expect(h.take('deleteFeedVideo').map((job) => job.payload)).toEqual([{guid}]);
		expect(h.dms).toEqual([]);
	});

	// the author gate of the post runs before the hold, so a banned author's video is not held until the 72 h
	// checkpoint fails it with a DM.
	it('drops the video of a banned author at the start of its scan without a frame or a DM', async () => {
		const h = createHarness();
		const banned = await h.toScanning();
		h.users.set(h.author.id, new User({...h.author.toRow(), flags: UserFlags.DISABLED}));
		h.limits.video = false;
		await h.service.scan(banned, 0);
		expect(await h.repository.get(banned)).toMatchObject({state: 'deleting', content: null});
		expect(h.take('scanFeedVideo')).toEqual([]);
		expect(h.take('deleteFeedVideo').map((job) => job.payload)).toEqual([{guid: banned}]);
		expect(h.getMetadata).not.toHaveBeenCalled();
		expect(h.published).toEqual([]);
		expect(h.dms).toEqual([]);
	});

	// ORTA-2: the feed's kill switch holds a video on its way as feature_feed_video does; it deletes nothing.
	it('holds the video of an author whose feed is off without a delete, a Bunny call or a DM', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		h.limits.feed = false;
		h.limits.video = false;
		const bunnyCalls = fakeBunnyStream.getCalls().length;
		for (const [minutes, video] of [
			[0, false],
			[15, true],
		] as const) {
			h.limits.video = video;
			vi.setSystemTime(T0 + minutes * MINUTE);
			await h.service.scan(guid, 0);
			expect((await h.repository.get(guid))?.state).toBe('scanning');
			const [held] = h.take('scanFeedVideo');
			expect(held!.payload).toEqual({guid, attempt: 0});
			expect(minutesFromNow(held!)).toBe(15);
		}
		expect(fakeBunnyStream.getCalls().length).toBe(bunnyCalls);
		expect(h.take('deleteFeedVideo')).toEqual([]);
		expect(h.dms).toEqual([]);

		h.limits.feed = true;
		vi.setSystemTime(T0 + 30 * MINUTE);
		await h.service.scan(guid, 0);
		expect(h.published).toHaveLength(1);
	});

	// ORTA-2: the kill switch turned on while the frames were read holds the post under the lock instead of deleting it.
	it('holds a video whose feed went off during its scan and posts it later without reading its frames again', async () => {
		const h = createHarness({
			answer: async () => {
				h.limits.feed = false;
				return {};
			},
		});
		const guid = await h.toScanning();
		await h.service.scan(guid, 0);
		expect(h.published).toEqual([]);
		expect((await h.repository.get(guid))?.state).toBe('scanning');
		expect(h.take('deleteFeedVideo')).toEqual([]);
		const [held] = h.take('scanFeedVideo');
		expect(held!.payload).toEqual({guid, attempt: 0});
		expect(minutesFromNow(held!)).toBe(15);

		h.limits.feed = true;
		vi.setSystemTime(T0 + 15 * MINUTE);
		await h.service.scan(guid, 0);
		expect(h.published).toHaveLength(1);
		expect(h.getMetadata).toHaveBeenCalledTimes(16);
		expect(h.dms).toEqual([]);
	});

	// a failed renewal of the clean mark costs at most a second frame scan, never the held video's chain.
	it('keeps holding a video when renewing its clean mark fails', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		h.limits.video = false;
		vi.spyOn(h.repository, 'keepClean').mockRejectedValue(new Error('kv down'));
		await h.service.scan(guid, 0);
		const [held] = h.take('scanFeedVideo');
		expect(held!.payload).toEqual({guid, attempt: 0});
		expect(minutesFromNow(held!)).toBe(15);
	});

	// the scan's one read of the author decides the post too.
	it('reads the author once for a scan that posts', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		h.findUser.mockClear();
		await h.service.scan(guid, 0);
		expect(h.published).toHaveLength(1);
		expect(h.findUser).toHaveBeenCalledTimes(1);
	});

	// a clean scan waiting for its post keeps its mark while feature_feed_video holds it past 30 minutes.
	it('posts a clean scan held for over 30 minutes without reading its frames again', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		const token = await h.repository.lockVideo(guid);
		await h.service.scan(guid, 0);
		// 20 s: 10 seek frames and 6 thumbnails.
		expect(h.getMetadata).toHaveBeenCalledTimes(16);
		await h.repository.unlockVideo(guid, token!);
		const [retry] = h.take('scanFeedVideo');
		const attempt = Number(retry!.payload.attempt);
		h.limits.video = false;
		for (const minutes of [1, 16, 31, 46]) {
			vi.setSystemTime(T0 + minutes * MINUTE);
			await h.service.scan(guid, attempt);
			const [held] = h.take('scanFeedVideo');
			expect(held!.payload).toEqual({guid, attempt});
			expect(minutesFromNow(held!)).toBe(15);
		}
		h.limits.video = true;
		vi.setSystemTime(T0 + 61 * MINUTE);
		await h.service.scan(guid, attempt);
		expect(h.published).toHaveLength(1);
		expect(h.getMetadata).toHaveBeenCalledTimes(16);
	});

	it('names the media evidence.ts as video/mp2t', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish();
		const row = (await h.repository.get(guid))!;
		const media = post.media![0]!;
		expect(media).toEqual({
			attachment_id: row.created_id,
			filename: 'evidence.ts',
			size: 1000n,
			description: null,
			width: 1080,
			height: 1920,
			content_type: 'video/mp2t',
			content_hash: null,
			placeholder: null,
			flags: 0,
			nsfw: false,
			duration: 20,
			stream_video_id: guid,
			stream_mp4_file: 'play_720p.mp4',
		});
		expect(feedStreamEvidenceKey(h.author.id, media)).toMatch(/\/evidence\.ts$/);
	});

	it('keeps an inconclusive scan unpublished and reschedules it with a growing delay without throwing', async () => {
		const h = createHarness({answer: async () => null});
		const guid = await h.toScanning();
		const start = (await h.repository.get(guid))!.scan_started_at!.getTime();
		for (let attempt = 0; attempt < 8; attempt++) {
			await expect(h.service.scan(guid, attempt)).resolves.toBeUndefined();
			const [job] = h.take('scanFeedVideo');
			expect(job!.payload).toEqual({guid, attempt: attempt + 1});
			expect(job!.options!.jobKey).toBe(`scan:${guid}:${start}:${attempt + 1}`);
			expect(minutesFromNow(job!)).toBe([1, 5, 15, 60, 180, 360, 360, 360][attempt]);
		}
		fakeBunnyStream.failWhen((call) => call.guid === guid && call.service === 'api', 500, 1);
		await expect(h.service.scan(guid, 8)).resolves.toBeUndefined();
		expect(minutesFromNow(h.take('scanFeedVideo')[0]!)).toBe(360);
		expect((await h.repository.get(guid))?.state).toBe('scanning');
		expect(h.published).toEqual([]);
	});

	it('a video with two NSFW frames is not published, is deleted from Bunny and its author gets a DM', async () => {
		const h = createHarness({
			answer: async (name) =>
				name === 'thumbnail_1' || name === 'thumbnail_2' ? {nsfw: true, nsfw_probability: 0.9} : {},
		});
		const guid = await h.toScanning();
		await h.service.scan(guid, 0);
		expect(h.published).toEqual([]);
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_rejected'}]);
		const [job] = h.take('deleteFeedVideo');
		await h.service.deleteVideo(String(job!.payload.guid), {});
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
		expect(await h.repository.get(guid)).toBeNull();
		expect(h.purged).toEqual([{urls: [`https://${settings.cdnHostname}/${guid}/`], priority: false}]);
	});

	it('a webhook after 4 days for a published guid still removes a re-uploaded video', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish();
		vi.setSystemTime(T0 + 4 * 24 * HOUR);
		fakeBunnyStream.updateVideo(guid, {dateUploaded: new Date().toISOString(), originalHash: 'REUPLOADED'});
		await h.service.handleWebhook(guid);
		expect(h.removed).toEqual([{post, priority: true}]);
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_rejected'}]);
	});

	it('does not remove a published post for a status change alone and re-reads it 15 minutes later', async () => {
		const h = createHarness();
		const {guid} = await h.publish();
		fakeBunnyStream.updateVideo(guid, {status: 3});
		await h.service.handleWebhook(guid);
		expect(h.removed).toEqual([]);
		const [job] = h.take('processFeedVideoWebhook');
		expect(job!.payload).toEqual({guid, recheck: 1});
		expect(minutesFromNow(job!)).toBe(15);
		await h.service.handleWebhook(guid, {recheck: 8});
		expect(h.take('processFeedVideoWebhook')).toEqual([]);

		fakeBunnyStream.updateVideo(guid, {status: 4, category: 'ADULT'});
		await h.service.handleWebhook(guid, {recheck: 1});
		expect(h.removed).toHaveLength(1);
	});

	it('joins the HLS segments of the largest rendition under 2 GiB in playlist order into evidence.ts before deleting a reported video', async () => {
		const h = createHarness();
		// 48 s: 12 segments, so a name-sorted listing (video0, video1, video10, …) differs from the playlist order.
		const {guid, post} = await h.publish({length: 48, resolutions: ['1080p', '720p', '360p']});
		for (let segment = 0; segment < 12; segment++) {
			const path = `1080p/video${segment}.ts`;
			fakeBunnyStream.setFile(guid, path, fakeBunnyStream.getFile(guid, path)!, 200_000_000);
		}
		await h.service.markReported(post);
		await h.service.keepReportedEvidence(post);
		const key = feedStreamEvidenceKey(h.author.id, post.media![0]!);
		expect(await h.repository.getReported(guid)).toBe(key);
		expect(h.take('keepFeedVideoEvidence')).toEqual([
			{
				task: 'keepFeedVideoEvidence',
				payload: {guid, evidenceKey: key},
				options: {jobKey: `feed-video-evidence:${guid}`},
			},
		]);

		const expected = Buffer.concat(
			Array.from({length: 12}, (_, segment) => fakeBunnyStream.getFile(guid, `720p/video${segment}.ts`)!),
		);
		await h.service.deleteVideo(guid, {});
		const stored = await h.storage.readObject(Config.s3.buckets.reports, key);
		expect(Buffer.from(stored).equals(expected)).toBe(true);
		expect(expected.length).toBe(12 * 188);
		expect(await h.storage.getObjectMetadata(Config.s3.buckets.reports, key)).toMatchObject({
			contentType: 'video/mp2t',
		});
		const calls = fakeBunnyStream.getCalls();
		const lastSegment = calls.findLastIndex((call) => call.path.endsWith('.ts'));
		const bunnyDelete = calls.findIndex((call) => call.method === 'DELETE');
		expect(calls.filter((call) => call.path.startsWith('1080p/video'))).toEqual([]);
		expect(bunnyDelete).toBeGreaterThan(lastSegment);
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
	});

	it('keeps no evidence and deletes nothing when a segment is shorter than Bunny lists it', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish();
		const key = feedStreamEvidenceKey(h.author.id, post.media![0]!);
		const segment = fakeBunnyStream.getFile(guid, '720p/video1.ts')!;
		fakeBunnyStream.setFile(guid, '720p/video1.ts', segment, segment.length + 10);
		expect(await h.service.keepEvidence(guid, key)).toBe('retry');
		expect(await h.storage.getObjectMetadata(Config.s3.buckets.reports, key)).toBeNull();
		const [retry] = h.take('keepFeedVideoEvidence');
		expect(retry!.payload).toEqual({guid, evidenceKey: key});
		expect(minutesFromNow(retry!)).toBe(1);
		await h.service.deleteVideo(guid, {evidence: key});
		expect(fakeBunnyStream.getVideo(guid)).not.toBeNull();
	});

	it('refuses a media playlist that names anything but videoN.ts', () => {
		const playlist = (uri: string) => `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000000,\n${uri}\n#EXT-X-ENDLIST\n`;
		expect(parseMediaPlaylist(playlist('video0.ts'))).toEqual(['video0.ts']);
		expect(
			parseMediaPlaylist('#EXTM3U\r\n#EXTINF:4.0,\r\nvideo0.ts\r\n#EXTINF:4.0,\r\nvideo1.ts\r\n#EXT-X-ENDLIST\r\n'),
		).toEqual(['video0.ts', 'video1.ts']);
		for (const uri of [
			'../original',
			'https://evil.test/video1.ts',
			'video1.ts?x=1',
			'720p/video1.ts',
			'seek/_0.jpg',
		]) {
			expect(() => parseMediaPlaylist(playlist(uri))).toThrow();
		}
		expect(() => parseMediaPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n')).toThrow();
		expect(() => parseMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=720x1280\n../720p/video.m3u8\n')).toThrow();
		expect(() => parseMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p/video.m3u8\n')).toThrow();
	});

	it('parses the master playlist of a portrait video', async () => {
		const guid = fakeBunnyStream.putVideo();
		await fakeBunnyStream.finishVideo(guid, {width: 1080, height: 1920, resolutions: ['720p', '360p']});
		const text = fakeBunnyStream.getFile(guid, 'playlist.m3u8')!.toString();
		expect(parseMasterPlaylist(text)).toEqual([
			{path: '720p', pixels: 720 * 1280},
			{path: '360p', pixels: 360 * 640},
		]);
	});

	it('does not copy evidence twice', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish();
		const key = feedStreamEvidenceKey(h.author.id, post.media![0]!);
		expect(await h.service.keepEvidence(guid, key)).toBe('kept');
		const reads = fakeBunnyStream.getCalls().length;
		expect(await h.service.keepEvidence(guid, key)).toBe('kept');
		expect(fakeBunnyStream.getCalls().length).toBe(reads);
		expect(h.storage.uploadObjectSpy).toHaveBeenCalledTimes(1);
		expect(h.jobs).toEqual([]);
	});

	it('keeps retrying a failed evidence copy daily after 8 attempts and never deletes the video from Bunny before it is kept', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish();
		const key = feedStreamEvidenceKey(h.author.id, post.media![0]!);
		fakeBunnyStream.failWhen((call) => call.guid === guid && call.path === 'playlist.m3u8', 500, 10);
		for (let attempt = 1; attempt <= 10; attempt++) {
			await expect(h.service.deleteVideo(guid, {priority: true, evidence: key})).resolves.toBeUndefined();
			const [job] = h.take('deleteFeedVideo');
			expect(job!.payload).toEqual({guid, priority: true, evidence: key});
			expect(minutesFromNow(job!)).toBe(RETRY_MINUTES[attempt - 1]);
			expect(await h.repository.countStuck()).toBe(attempt >= 8 ? 1 : 0);
		}
		expect(fakeBunnyStream.getCalls().filter((call) => call.method === 'DELETE')).toEqual([]);
		expect(fakeBunnyStream.getVideo(guid)).not.toBeNull();
		expect(await h.repository.get(guid)).toMatchObject({state: 'deleting', content: null});

		await h.service.deleteVideo(guid, {priority: true, evidence: key});
		expect(await h.storage.getObjectMetadata(Config.s3.buckets.reports, key)).not.toBeNull();
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
		expect(await h.repository.countStuck()).toBe(0);
		expect(h.purged).toEqual([{urls: [`https://${settings.cdnHostname}/${guid}/`], priority: true}]);
	});

	it('retries a failed Bunny delete with a growing delay, then once a day without end, lists it as stuck and clears it on success', async () => {
		const h = createHarness();
		const warn = warnings();
		const guid = await h.start();
		await h.service.cancel(h.author, guid);
		h.take('deleteFeedVideo');
		fakeBunnyStream.failWhen((call) => call.guid === guid && call.method === 'DELETE', 500, 10);
		for (let attempt = 1; attempt <= 10; attempt++) {
			await h.service.deleteVideo(guid, {});
			const [job] = h.take('deleteFeedVideo');
			expect(job!.payload).toEqual({guid});
			expect(minutesFromNow(job!)).toBe(RETRY_MINUTES[attempt - 1]);
			expect(await h.repository.countStuck()).toBe(attempt >= 8 ? 1 : 0);
		}
		expect(warn).toHaveBeenCalledWith({guid, attempts: 10}, 'Feed video delete still failing');
		expect(await h.repository.get(guid)).not.toBeNull();

		await h.service.deleteVideo(guid, {});
		expect(h.jobs).toEqual([]);
		expect(await h.repository.countStuck()).toBe(0);
		expect(await h.repository.get(guid)).toBeNull();
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
	});

	it('a video cancelled while its scan runs is never published and its row is not recreated', async () => {
		// The scan holds at its first NSFW call until the test opens the gate.
		const gate = () => {
			let open!: () => void;
			let hit!: () => void;
			return {
				opened: new Promise<void>((resolve) => {
					open = resolve;
				}),
				reached: new Promise<void>((resolve) => {
					hit = resolve;
				}),
				open: () => open(),
				hit: () => hit(),
			};
		};
		let current = gate();
		const h = createHarness({
			answer: async () => {
				const held = current;
				held.hit();
				await held.opened;
				return {};
			},
		});

		// Cancelled, its delete not run yet: the row stays deleting and no post appears.
		const pendingDelete = await h.toScanning();
		const firstScan = h.service.scan(pendingDelete, 0);
		await current.reached;
		await h.service.cancel(h.author, pendingDelete);
		current.open();
		await firstScan;
		expect(h.published).toEqual([]);
		expect(await h.repository.get(pendingDelete)).toMatchObject({state: 'deleting', content: null, post_id: null});

		// Cancelled and deleted: the scan finds no row and writes none.
		current = gate();
		const deleted = await h.toScanning();
		const secondScan = h.service.scan(deleted, 0);
		await current.reached;
		await h.service.cancel(h.author, deleted);
		const job = h.take('deleteFeedVideo').find((queued) => queued.payload.guid === deleted);
		await h.service.deleteVideo(String(job!.payload.guid), {});
		expect(await h.repository.get(deleted)).toBeNull();
		current.open();
		await secondScan;
		expect(h.published).toEqual([]);
		expect(await h.repository.get(deleted)).toBeNull();
		expect(h.dms).toEqual([]);
	});

	it('a scan that finds the video lock taken retries in 30 seconds', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		const token = await h.repository.lockVideo(guid);
		await h.service.scan(guid, 0);
		expect(h.published).toEqual([]);
		const [job] = h.take('scanFeedVideo');
		expect(job!.payload).toEqual({guid, attempt: 1});
		expect(job!.options!.runAt!.getTime() - Date.now()).toBe(30_000);
		await h.repository.unlockVideo(guid, token!);
		await h.service.scan(guid, 1);
		expect(h.published).toHaveLength(1);
	});

	it('runs one scan at a time and queues one tagging wait', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		await Promise.all([h.service.scan(guid, 0), h.service.scan(guid, 0)]);
		// 20 s: 10 seek frames and 6 thumbnails, read once.
		expect(h.getMetadata).toHaveBeenCalledTimes(16);
		expect(h.published).toHaveLength(1);

		const waiting = await h.toScanning({category: null});
		await Promise.all([h.service.scan(waiting, 0), h.service.scan(waiting, 1)]);
		expect(h.take('scanFeedVideo')).toHaveLength(1);
	});

	it('nulls the text of a video as it moves to deleting', async () => {
		const h = createHarness();
		const guid = await h.start();
		await h.service.cancel(h.author, guid);
		expect(await h.repository.get(guid)).toMatchObject({state: 'deleting', content: null});
		expect(h.take('deleteFeedVideo')).toEqual([
			{task: 'deleteFeedVideo', payload: {guid}, options: {jobKey: `feed-video-delete:${guid}`}},
		]);
		expect(h.dms).toEqual([]);
		await expect(h.service.cancel(h.author, guid)).rejects.toBeInstanceOf(NotFoundError);
		expect(await h.service.listPending(h.author)).toEqual([]);

		const {guid: publishedGuid} = await h.publish();
		await expect(h.service.cancel(h.author, publishedGuid)).rejects.toBeInstanceOf(NotFoundError);
		const token = await h.repository.lockVideo(publishedGuid);
		await h.service.deleteVideo(publishedGuid, {});
		expect(h.take('deleteFeedVideo')).toHaveLength(1);
		await h.repository.unlockVideo(publishedGuid, token!);
		await h.service.deleteVideo(publishedGuid, {});
		expect(await h.repository.get(publishedGuid)).toBeNull();
	});

	it('fails the in-flight videos of a deleted account without a DM', async () => {
		const h = createHarness();
		const inFlight = await h.start();
		const {guid: publishedGuid} = await h.publish();
		await h.service.deleteUserVideos(h.author.id);
		expect(await h.repository.get(inFlight)).toMatchObject({state: 'deleting'});
		expect(await h.repository.get(publishedGuid)).toMatchObject({state: 'published'});
		expect(h.take('deleteFeedVideo').map((job) => job.payload.guid)).toEqual([inFlight]);
		expect(h.dms).toEqual([]);
	});

	it('enqueues one reconcile job per hour, shard and checkpoint and moves the cursor', async () => {
		const h = createHarness();
		const nowHour = pendingHourAt(Date.now());
		await h.repository.setReconcileCursor(nowHour - 1);
		expect(await h.service.enqueueReconcile()).toBe(192);
		const jobs = h.take('reconcileFeedVideoBucket');
		expect(jobs).toHaveLength(192);
		for (const checkpoint of [1, 9, 72]) {
			for (const shard of [0, 17, 63]) {
				expect(jobs).toContainEqual({
					task: 'reconcileFeedVideoBucket',
					payload: {hour: nowHour - checkpoint, shard, checkpoint},
					options: {jobKey: `feed-video-rc:${nowHour - checkpoint}:${shard}:${checkpoint}`},
				});
			}
		}
		expect(new Set(jobs.map((job) => job.options!.jobKey)).size).toBe(192);
		expect(await h.repository.getReconcileCursor()).toBe(nowHour);
		expect(await h.service.enqueueReconcile()).toBe(0);

		vi.setSystemTime(T0 + HOUR);
		const token = await h.repository.lockReconcile();
		expect(await h.service.enqueueReconcile()).toBe(0);
		await h.repository.unlockReconcile(token!);
		expect(await h.service.enqueueReconcile()).toBe(192);
	});

	it('catches up at most 96 hours and warns past 24', async () => {
		const h = createHarness();
		const warn = warnings();
		const nowHour = pendingHourAt(Date.now());
		await h.repository.setReconcileCursor(nowHour - 24);
		expect(await h.service.enqueueReconcile()).toBe(24 * 192);
		expect(warn).not.toHaveBeenCalled();

		await h.repository.setReconcileCursor(nowHour - 200);
		expect(await h.service.enqueueReconcile()).toBe(96 * 192);
		expect(warn).toHaveBeenCalledWith({hours: 200}, 'Feed video reconcile is catching up');
		const hours = new Set(
			h.take('reconcileFeedVideoBucket').map((job) => Number(job.payload.hour) + Number(job.payload.checkpoint)),
		);
		expect(Math.min(...hours)).toBe(nowHour - 95);

		await h.kv.del('feed:video:reconcile:cursor');
		expect(await h.service.enqueueReconcile()).toBe(24 * 192);
	});

	it('queues the Bunny delete again from a reconcile checkpoint when its first hand-off failed', async () => {
		const h = createHarness({answer: async (name) => (name === 'poster' ? {nsfw: true, nsfw_probability: 0.9} : {})});
		const guid = await h.toScanning();
		h.queue.failing = true;
		await expect(h.service.scan(guid, 0)).rejects.toThrow('queue down');
		h.queue.failing = false;
		const row = (await h.repository.get(guid))!;
		expect(row).toMatchObject({state: 'deleting', content: null});
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_rejected'}]);
		const partition = {hour: pendingHour(row.created_id), shard: pendingShard(guid)};
		expect(await h.repository.listPending(partition.hour, partition.shard, null, 10)).toContain(guid);

		await h.service.reconcileBucket({...partition, checkpoint: 1});
		expect(h.take('deleteFeedVideo')).toEqual([
			{task: 'deleteFeedVideo', payload: {guid}, options: {jobKey: `feed-video-delete:${guid}`}},
		]);
		await h.service.deleteVideo(guid, {});
		expect(await h.repository.get(guid)).toBeNull();
		expect(await h.repository.listPending(partition.hour, partition.shard, null, 10)).not.toContain(guid);
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
	});

	it('a bucket job fails uploads at 9 h and everything unpublished at 72 h', async () => {
		const h = createHarness();
		const uploading = await h.start();
		const processing = await h.start();
		fakeBunnyStream.updateVideo(processing, {status: 2});
		await h.service.handleWebhook(processing);
		const scanning = await h.toScanning();
		const bucket = async (guid: string, checkpoint: 1 | 9 | 72) => {
			const row = (await h.repository.get(guid))!;
			await h.service.reconcileBucket({hour: pendingHour(row.created_id), shard: pendingShard(guid), checkpoint});
		};

		vi.setSystemTime(T0 + 9 * HOUR + 7 * MINUTE);
		await bucket(uploading, 9);
		await bucket(processing, 9);
		expect(await h.repository.get(uploading)).toMatchObject({state: 'deleting', content: null});
		expect(await h.repository.get(processing)).toMatchObject({state: 'processing'});
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_failed'}]);

		vi.setSystemTime(T0 + 72 * HOUR + 7 * MINUTE);
		await bucket(processing, 72);
		await bucket(scanning, 72);
		expect(await h.repository.get(processing)).toMatchObject({state: 'deleting'});
		expect(await h.repository.get(scanning)).toMatchObject({state: 'deleting'});
		expect(h.dms).toHaveLength(3);
		expect(h.take('deleteFeedVideo')).toHaveLength(3);
		expect(h.published).toEqual([]);
	});

	it('a published video is read from Bunny exactly once, at its 9 h (or 72 h) checkpoint, and then leaves both indexes', async () => {
		const h = createHarness();
		const {guid} = await h.publish();
		const row = (await h.repository.get(guid))!;
		const partition = {hour: pendingHour(row.created_id), shard: pendingShard(guid)};
		const reads = h.apiReads(guid);
		await h.service.reconcileBucket({...partition, checkpoint: 1});
		expect(h.apiReads(guid)).toBe(reads);
		await h.service.reconcileBucket({...partition, checkpoint: 9});
		expect(h.apiReads(guid)).toBe(reads + 1);
		expect(await h.repository.listPending(partition.hour, partition.shard, null, 10)).not.toContain(guid);
		expect(await h.repository.listByAuthor(h.author.id, 10)).toEqual([]);
		expect(await h.repository.get(guid)).toMatchObject({state: 'published'});
		expect(h.removed).toEqual([]);

		// Published after its 9 h checkpoint: the 72 h checkpoint makes the one read.
		const late = await h.toScanning();
		const lateRow = (await h.repository.get(late))!;
		const latePartition = {hour: pendingHour(lateRow.created_id), shard: pendingShard(late)};
		fakeBunnyStream.updateVideo(late, {category: 'untagged'});
		await h.service.scan(late, 0);
		h.take('scanFeedVideo');
		await h.service.reconcileBucket({...latePartition, checkpoint: 9});
		h.take('scanFeedVideo');
		fakeBunnyStream.updateVideo(late, {category: 'other'});
		vi.setSystemTime(T0 + 10 * HOUR);
		await h.service.scan(late, 6);
		expect((await h.repository.get(late))?.state).toBe('published');
		const lateReads = h.apiReads(late);
		await h.service.reconcileBucket({...latePartition, checkpoint: 72});
		expect(h.apiReads(late)).toBe(lateReads + 1);
		expect(await h.repository.listPending(latePartition.hour, latePartition.shard, null, 10)).not.toContain(late);
		expect(await h.repository.listByAuthor(h.author.id, 10)).toEqual([]);
	});

	it('removes a published post when that last check finds a re-upload', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish();
		const row = (await h.repository.get(guid))!;
		fakeBunnyStream.updateVideo(guid, {dateUploaded: new Date(T0 + HOUR).toISOString()});
		await h.service.reconcileBucket({hour: pendingHour(row.created_id), shard: pendingShard(guid), checkpoint: 9});
		expect(h.removed).toEqual([{post, priority: true}]);
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_rejected'}]);
		// the priority removal records the evidence key itself (FeedPostService.removePost); the check does not.
		expect(await h.repository.getReported(guid)).toBeNull();
	});

	it('keeps the evidence a removal asked for before any delete, a plain one from a checkpoint included', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish();
		const key = feedStreamEvidenceKey(h.author.id, post.media![0]!);
		fakeBunnyStream.failWhen((call) => call.guid === guid && call.path === 'playlist.m3u8', 500, 2);
		await h.service.deleteVideo(guid, {priority: true, evidence: key});
		expect(h.take('deleteFeedVideo')).toHaveLength(1);

		const row = (await h.repository.get(guid))!;
		await h.service.reconcileBucket({hour: pendingHour(row.created_id), shard: pendingShard(guid), checkpoint: 9});
		const [plain] = h.take('deleteFeedVideo');
		expect(plain!.payload).toEqual({guid});
		await h.service.deleteVideo(guid, {});
		expect(fakeBunnyStream.getCalls().filter((call) => call.method === 'DELETE')).toEqual([]);
		expect(fakeBunnyStream.getVideo(guid)).not.toBeNull();

		h.take('deleteFeedVideo');
		await h.service.deleteVideo(guid, {});
		expect(await h.storage.getObjectMetadata(Config.s3.buckets.reports, key)).not.toBeNull();
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
	});

	it('sends a video re-uploaded while it is scanned back to processing and scans the new upload before any post', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		const first = fakeBunnyStream.getVideo(guid)!;
		expect(await h.repository.get(guid)).toMatchObject({
			state: 'scanning',
			uploaded_at: first.dateUploaded,
			original_hash: first.originalHash,
		});

		vi.setSystemTime(T0 + 5 * MINUTE);
		fakeBunnyStream.updateVideo(guid, {status: 3, dateUploaded: new Date().toISOString(), originalHash: 'REUPLOADED'});
		await h.service.handleWebhook(guid);
		expect((await h.repository.get(guid))?.state).toBe('processing');
		await h.service.scan(guid, 0);
		expect(h.published).toEqual([]);

		fakeBunnyStream.updateVideo(guid, {status: 4});
		await h.service.handleWebhook(guid);
		expect(await h.repository.get(guid)).toMatchObject({state: 'scanning', original_hash: 'REUPLOADED'});
		expect(h.take('scanFeedVideo').map((job) => job.payload)).toEqual([{guid, attempt: 0}]);
		await h.service.scan(guid, 0);
		expect(h.published).toHaveLength(1);
		expect(await h.repository.get(guid)).toMatchObject({state: 'published', original_hash: 'REUPLOADED'});
	});

	// Yeni-2: a re-upload during the scan goes back through the one exact size check of the first webhook.
	it('checks the size of a video re-uploaded while it is scanned', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		vi.setSystemTime(T0 + 5 * MINUTE);
		fakeBunnyStream.setFile(guid, 'original', Buffer.from('x'), 524_288_001);
		fakeBunnyStream.updateVideo(guid, {status: 3, dateUploaded: new Date().toISOString(), originalHash: 'LARGE'});
		await h.service.handleWebhook(guid);
		expect(await h.repository.get(guid)).toMatchObject({state: 'deleting', content: null});
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_too_large'}]);
		expect(h.take('deleteFeedVideo')).toHaveLength(1);
	});

	// Yeni-3: the first scan and the tagging wait of the new upload are keyed by its scan start, so neither the job
	// keys nor the tagging claim of the first upload hold them back.
	it('scans a video re-uploaded while it waited for tagging under keys of its own scan', async () => {
		const h = createHarness();
		const guid = await h.toScanning({category: 'untagged'});
		const first = (await h.repository.get(guid))!.scan_started_at!.getTime();
		await h.service.scan(guid, 0);
		expect(h.take('scanFeedVideo').map((job) => job.options!.jobKey)).toEqual([`scan:${guid}:${first}:tag`]);

		vi.setSystemTime(T0 + 5 * MINUTE);
		fakeBunnyStream.updateVideo(guid, {status: 3, dateUploaded: new Date().toISOString(), originalHash: 'REUPLOADED'});
		await h.service.handleWebhook(guid);
		fakeBunnyStream.updateVideo(guid, {status: 4});
		await h.service.handleWebhook(guid);
		const second = (await h.repository.get(guid))!.scan_started_at!.getTime();
		expect(second).toBe(T0 + 5 * MINUTE);
		expect(h.take('scanFeedVideo').map((job) => job.options!.jobKey)).toEqual([`scan:${guid}:${second}:0`]);

		await h.service.scan(guid, 0);
		expect(h.take('scanFeedVideo')).toEqual([
			{
				task: 'scanFeedVideo',
				payload: {guid, attempt: 1},
				options: {runAt: new Date(second + 30 * MINUTE), jobKey: `scan:${guid}:${second}:tag`},
			},
		]);
	});

	// a retry of the new upload's scan is not taken for the first upload's retry of the same attempt.
	it('keys the scan retries of a video re-uploaded while it is scanned by its own scan', async () => {
		const h = createHarness({answer: async () => null});
		const guid = await h.toScanning();
		const first = (await h.repository.get(guid))!.scan_started_at!.getTime();
		await h.service.scan(guid, 0);
		expect(h.take('scanFeedVideo').map((job) => job.options!.jobKey)).toEqual([`scan:${guid}:${first}:1`]);

		vi.setSystemTime(T0 + MINUTE);
		fakeBunnyStream.updateVideo(guid, {status: 3, dateUploaded: new Date().toISOString(), originalHash: 'REUPLOADED'});
		await h.service.handleWebhook(guid);
		fakeBunnyStream.updateVideo(guid, {status: 4});
		await h.service.handleWebhook(guid);
		h.take('scanFeedVideo');
		await h.service.scan(guid, 0);
		expect(h.take('scanFeedVideo').map((job) => job.options!.jobKey)).toEqual([`scan:${guid}:${T0 + MINUTE}:1`]);
	});

	it('does not post a scan whose upload changed on Bunny while the frames were read', async () => {
		let reached!: () => void;
		let open!: () => void;
		const atFrames = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const h = createHarness({
			answer: async () => {
				reached();
				await gate;
				return {};
			},
		});
		const guid = await h.toScanning();
		const scan = h.service.scan(guid, 0);
		await atFrames;
		fakeBunnyStream.updateVideo(guid, {dateUploaded: new Date(T0 + MINUTE).toISOString(), originalHash: 'REUPLOADED'});
		open();
		await scan;
		expect(h.published).toEqual([]);
		expect((await h.repository.get(guid))?.state).toBe('scanning');
		expect(h.take('scanFeedVideo').map((job) => job.payload)).toEqual([{guid, attempt: 1}]);
	});

	it('fails videos still on their way after 73 hours when their author starts or lists videos', async () => {
		const h = createHarness();
		const stale = [await h.start(), await h.start(), await h.start()];
		vi.setSystemTime(T0 + 73 * HOUR + MINUTE);
		const fresh = await h.start();
		for (const guid of stale) expect(await h.repository.get(guid)).toMatchObject({state: 'deleting', content: null});
		expect(h.dms).toEqual(stale.map(() => ({authorId: h.author.id, key: 'feed.video_failed'})));
		expect(
			h
				.take('deleteFeedVideo')
				.map((job) => job.payload.guid)
				.sort(),
		).toEqual([...stale].sort());
		expect((await h.service.listPending(h.author)).map((video) => video.id)).toEqual([fresh]);

		vi.setSystemTime(T0 + 2 * (73 * HOUR + MINUTE));
		expect(await h.service.listPending(h.author)).toEqual([]);
		expect(await h.repository.get(fresh)).toMatchObject({state: 'deleting', content: null});
	});

	it('retries a video that fails in a bucket job on its own job without failing the bucket', async () => {
		const h = createHarness();
		const guid = await h.start();
		const row = (await h.repository.get(guid))!;
		const partition = {hour: pendingHour(row.created_id), shard: pendingShard(guid)};
		vi.setSystemTime(T0 + 9 * HOUR + 7 * MINUTE);
		const token = await h.repository.lockVideo(guid);
		await expect(h.service.reconcileBucket({...partition, checkpoint: 9})).resolves.toBeUndefined();
		const [retry] = h.take('reconcileFeedVideoBucket');
		expect(retry).toEqual({
			task: 'reconcileFeedVideoBucket',
			payload: {...partition, checkpoint: 9, guid},
			options: {
				runAt: new Date(Date.now() + 30_000),
				jobKey: `feed-video-rc:${partition.hour}:${partition.shard}:9:${guid}`,
			},
		});
		type OneVideo = {hour: number; shard: number; checkpoint: 9; guid: string};
		// The video's own job fails while the lock is taken (the worker retries it) and queues nothing more.
		await expect(h.service.reconcileBucket(retry!.payload as OneVideo)).rejects.toThrow();
		expect(h.jobs).toEqual([]);
		await h.repository.unlockVideo(guid, token!);
		await h.service.reconcileBucket(retry!.payload as OneVideo);
		expect(await h.repository.get(guid)).toMatchObject({state: 'deleting'});
	});

	// the flag holds the post, not the scan: every 15 minutes, the same attempt, the frames read once. a
	// held video makes no Bunny call.
	it('holds a clean video back while feature_feed_video is 0 and posts it once the flag is back', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		h.limits.video = false;
		const bunnyCalls = fakeBunnyStream.getCalls().length;
		for (const minutes of [0, 15]) {
			vi.setSystemTime(T0 + minutes * MINUTE);
			await h.service.scan(guid, 0);
			expect(h.published).toEqual([]);
			expect((await h.repository.get(guid))?.state).toBe('scanning');
			const [retry] = h.take('scanFeedVideo');
			expect(retry!.payload).toEqual({guid, attempt: 0});
			expect(minutesFromNow(retry!)).toBe(15);
		}
		expect(fakeBunnyStream.getCalls().length).toBe(bunnyCalls);

		h.limits.video = true;
		vi.setSystemTime(T0 + 30 * MINUTE);
		await h.service.scan(guid, 0);
		expect(h.published).toHaveLength(1);
		// 20 s: 10 seek frames and 6 thumbnails, read once.
		expect(h.getMetadata).toHaveBeenCalledTimes(16);
	});

	// a flag turned off while the frames were read holds the post; the frames are not read again.
	it('holds a video whose flag went off during its scan and posts it later without reading its frames again', async () => {
		const h = createHarness({
			answer: async () => {
				h.limits.video = false;
				return {};
			},
		});
		const guid = await h.toScanning();
		await h.service.scan(guid, 0);
		expect(h.published).toEqual([]);
		const [held] = h.take('scanFeedVideo');
		expect(held!.payload).toEqual({guid, attempt: 0});
		expect(minutesFromNow(held!)).toBe(15);

		h.limits.video = true;
		vi.setSystemTime(T0 + 15 * MINUTE);
		await h.service.scan(guid, 0);
		expect(h.published).toHaveLength(1);
		expect(h.getMetadata).toHaveBeenCalledTimes(16);
	});

	// the tag Bunny gives while the frames are read counts as much as the frames.
	it('does not post a clean scan when Bunny tags the video adult while the frames were read', async () => {
		let reached!: () => void;
		let open!: () => void;
		const atFrames = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const h = createHarness({
			answer: async () => {
				reached();
				await gate;
				return {};
			},
		});
		const guid = await h.toScanning();
		const scan = h.service.scan(guid, 0);
		await atFrames;
		fakeBunnyStream.updateVideo(guid, {category: 'adult'});
		open();
		await scan;
		expect(h.published).toEqual([]);
		expect(await h.repository.get(guid)).toMatchObject({state: 'deleting', content: null});
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_rejected'}]);
	});

	it('queues the tagging wait as the next attempt, so a late first scan does not swallow it', async () => {
		const h = createHarness();
		const guid = await h.toScanning({category: 'untagged'});
		const startedAt = (await h.repository.get(guid))!.scan_started_at!.getTime();
		vi.setSystemTime(startedAt + 27 * MINUTE);
		await h.service.scan(guid, 0);
		const [wait] = h.take('scanFeedVideo');
		vi.setSystemTime(startedAt + 30 * MINUTE);
		await h.service.scan(guid, Number(wait!.payload.attempt));
		expect(h.published).toHaveLength(1);
	});

	it('posts on retry without scanning the frames again when a clean scan found the lock taken', async () => {
		const h = createHarness();
		const guid = await h.toScanning();
		const token = await h.repository.lockVideo(guid);
		await h.service.scan(guid, 0);
		// 20 s: 10 seek frames and 6 thumbnails.
		expect(h.getMetadata).toHaveBeenCalledTimes(16);
		const [retry] = h.take('scanFeedVideo');
		await h.repository.unlockVideo(guid, token!);
		await h.service.scan(guid, Number(retry!.payload.attempt));
		expect(h.getMetadata).toHaveBeenCalledTimes(16);
		expect(h.published).toHaveLength(1);
	});

	it('removes the post of a published video Bunny no longer has and tells its author', async () => {
		const h = createHarness();
		const {guid, post} = await h.publish();
		const row = (await h.repository.get(guid))!;
		await new BunnyStreamClient(settings).deleteVideo(guid);
		await h.service.reconcileBucket({hour: pendingHour(row.created_id), shard: pendingShard(guid), checkpoint: 9});
		expect(h.removed).toEqual([{post, priority: undefined}]);
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_gone'}]);
	});

	// Yeni-4: a 404 from the API alone (a wrong library or key answers it for every video) removes nothing.
	it('keeps the post of a published video the API does not find while its storage still lists it', async () => {
		const h = createHarness();
		const warn = warnings();
		const {guid} = await h.publish();
		const row = (await h.repository.get(guid))!;
		fakeBunnyStream.failWhen((call) => call.guid === guid && call.service === 'api' && call.method === 'GET', 404, 1);
		await h.service.reconcileBucket({hour: pendingHour(row.created_id), shard: pendingShard(guid), checkpoint: 9});
		expect(h.removed).toEqual([]);
		expect(h.dms).toEqual([]);
		expect(warn).toHaveBeenCalledWith(
			{guid},
			'Bunny Stream does not find a published feed video its storage still lists; keeping the post',
		);
	});

	// past 20 in one hour, a gone video is taken for a misconfiguration: no post of a gone video is removed
	// until an operator deletes the halt key, which never expires.
	it('halts removing the posts of gone videos past 20 an hour until the halt key is deleted', async () => {
		const h = createHarness();
		const error = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'error');
		const {guid, post} = await h.publish();
		const row = (await h.repository.get(guid))!;
		await new BunnyStreamClient(settings).deleteVideo(guid);
		for (let gone = 0; gone < 20; gone++) await h.repository.countGone(pendingHourAt(Date.now()));
		await h.service.reconcileBucket({hour: pendingHour(row.created_id), shard: pendingShard(guid), checkpoint: 9});
		expect(h.removed).toEqual([]);
		expect(h.dms).toEqual([]);
		expect(h.posts.get(post.post_id)).toBeDefined();
		expect(error).toHaveBeenCalledWith(
			{guid, gone: 21},
			'Too many published feed videos are gone from Bunny this hour; removing their posts is halted until feed:video:gone:halt is deleted',
		);
		expect(await h.kv.ttl('feed:video:gone:halt')).toBe(-1);
		await h.service.handleWebhook(guid);
		expect(h.removed).toEqual([]);
		expect(error).toHaveBeenLastCalledWith(
			{guid},
			'Removing the posts of feed videos gone from Bunny is halted; keeping the post',
		);

		// the halt keeps the hour's count, so a halt deleted within its hour comes back at the next gone video.
		const hour = pendingHourAt(Date.now());
		expect(await h.kv.get(`feed:video:gone:${hour}`)).toBe('21');
		await h.kv.del('feed:video:gone:halt');
		await h.service.handleWebhook(guid);
		expect(h.removed).toEqual([]);
		expect(error).toHaveBeenLastCalledWith(
			{guid, gone: 22},
			'Too many published feed videos are gone from Bunny this hour; removing their posts is halted until feed:video:gone:halt is deleted',
		);

		// Deleted by the operator: the next hour counts from zero.
		await h.kv.del('feed:video:gone:halt');
		vi.setSystemTime(T0 + HOUR);
		await h.service.handleWebhook(guid);
		expect(h.removed).toEqual([{post, priority: undefined}]);
		expect(h.dms).toEqual([{authorId: h.author.id, key: 'feed.video_gone'}]);
	});

	// A halt set by another check after this one counted still keeps the post.
	it('removes no post of a gone video when a halt comes between its count and its removal', async () => {
		const h = createHarness();
		const error = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'error');
		const {guid} = await h.publish();
		const row = (await h.repository.get(guid))!;
		await new BunnyStreamClient(settings).deleteVideo(guid);
		const countGone = h.repository.countGone.bind(h.repository);
		vi.spyOn(h.repository, 'countGone').mockImplementation(async (hour) => {
			const gone = await countGone(hour);
			await h.kv.set('feed:video:gone:halt', '1');
			return gone;
		});
		await h.service.reconcileBucket({hour: pendingHour(row.created_id), shard: pendingShard(guid), checkpoint: 9});
		expect(h.removed).toEqual([]);
		expect(h.dms).toEqual([]);
		expect(error).toHaveBeenCalledWith(
			{guid},
			'Removing the posts of feed videos gone from Bunny is halted; keeping the post',
		);
	});

	// the hourly reconcile line says whether gone-video removals are halted.
	it('logs whether gone-video removals are halted with every reconcile run', async () => {
		const h = createHarness();
		const info = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'info');
		await h.repository.setReconcileCursor(pendingHourAt(Date.now()) - 1);
		await h.service.enqueueReconcile();
		expect(info).toHaveBeenLastCalledWith({queued: 192, stuck: 0, goneHalted: false}, 'Feed video reconcile queued');
		await h.kv.set('feed:video:gone:halt', '1');
		vi.setSystemTime(T0 + HOUR);
		await h.service.enqueueReconcile();
		expect(info).toHaveBeenLastCalledWith({queued: 192, stuck: 0, goneHalted: true}, 'Feed video reconcile queued');
	});

	it('starts no second scan chain from a checkpoint while a scan of the video is queued', async () => {
		const h = createHarness({answer: async () => null});
		const guid = await h.toScanning();
		const row = (await h.repository.get(guid))!;
		const partition = {hour: pendingHour(row.created_id), shard: pendingShard(guid)};
		await h.service.scan(guid, 0);
		expect(h.take('scanFeedVideo').map((job) => job.payload)).toEqual([{guid, attempt: 1}]);
		await h.service.reconcileBucket({...partition, checkpoint: 1});
		expect(h.take('scanFeedVideo')).toEqual([]);

		// The queued scan was lost: once its wait (and 10 minutes) passed, a checkpoint queues one.
		vi.setSystemTime(T0 + 9 * HOUR + 7 * MINUTE);
		await h.service.reconcileBucket({...partition, checkpoint: 9});
		expect(h.take('scanFeedVideo')).toEqual([
			{task: 'scanFeedVideo', payload: {guid, attempt: 5}, options: {jobKey: `scan:${guid}:rc9`}},
		]);
	});

	it('keeps jobs due in over a minute in KV minute buckets until the minute cron hands each over once', async () => {
		const h = createHarness();
		const deferring = deferLongWaits(h.worker, h.repository);
		const soon = {runAt: new Date(T0 + 30_000), jobKey: 'scan:a:1'};
		const later = {runAt: new Date(T0 + 15 * MINUTE + 5_000), jobKey: 'scan:b:3'};
		const tomorrow = {runAt: new Date(T0 + 24 * HOUR), jobKey: 'feed-video-delete:c:d9'};
		await deferring.addJob('scanFeedVideo', {guid: 'a', attempt: 1}, soon);
		await deferring.addJob('scanFeedVideo', {guid: 'b', attempt: 3}, later);
		await deferring.addJob('deleteFeedVideo', {guid: 'c'}, tomorrow);
		expect(h.take('scanFeedVideo')).toEqual([{task: 'scanFeedVideo', payload: {guid: 'a', attempt: 1}, options: soon}]);
		expect(h.jobs).toEqual([]);

		expect(await drainDueJobs(h.repository, h.worker, T0 + 14 * MINUTE)).toBe(0);
		// The cron at hh:15:00 hands over the hh:15:05 job with its run time; the worker waits the last seconds.
		vi.setSystemTime(T0 + 15 * MINUTE);
		h.queue.failing = true;
		await expect(drainDueJobs(h.repository, h.worker)).rejects.toThrow('queue down');
		h.queue.failing = false;
		expect(await drainDueJobs(h.repository, h.worker)).toBe(1);
		expect(h.take('scanFeedVideo')).toEqual([
			{task: 'scanFeedVideo', payload: {guid: 'b', attempt: 3}, options: later},
		]);
		expect(await drainDueJobs(h.repository, h.worker)).toBe(0);

		// A day later: a held lock moves nothing, then the cron catches up from its cursor.
		vi.setSystemTime(T0 + 24 * HOUR + 30_000);
		const token = await h.repository.lockDue();
		expect(await drainDueJobs(h.repository, h.worker)).toBe(0);
		await h.repository.unlockDue(token!);
		expect(await drainDueJobs(h.repository, h.worker)).toBe(1);
		expect(h.take('deleteFeedVideo')).toEqual([{task: 'deleteFeedVideo', payload: {guid: 'c'}, options: tomorrow}]);
	});

	it('hands over at most 5 000 due jobs a run and leaves the rest for the next minute', async () => {
		const h = createHarness();
		const deferring = deferLongWaits(h.worker, h.repository);
		// The cron's first run sets its cursor.
		expect(await drainDueJobs(h.repository, h.worker)).toBe(0);
		for (let index = 0; index < 5001; index++) {
			await deferring.addJob(
				'scanFeedVideo',
				{guid: `g${index}`, attempt: 2},
				{runAt: new Date(T0 + 5 * MINUTE), jobKey: `scan:g${index}:2`},
			);
		}
		// Half an hour without the cron: the backlog of an old minute is not skipped past.
		vi.setSystemTime(T0 + 35 * MINUTE);
		expect(await drainDueJobs(h.repository, h.worker)).toBe(5000);
		expect(await drainDueJobs(h.repository, h.worker)).toBe(1);
		expect(new Set(h.take('scanFeedVideo').map((job) => job.options!.jobKey)).size).toBe(5001);
	});

	// a worker that starts late (no cursor yet) still hands over what fell due before its first run.
	it('hands over on the first run of the cron the jobs that fell due before it', async () => {
		const h = createHarness();
		const deferring = deferLongWaits(h.worker, h.repository);
		const early = {runAt: new Date(T0 + 5 * MINUTE), jobKey: 'scan:a:2'};
		await deferring.addJob('scanFeedVideo', {guid: 'a', attempt: 2}, early);
		vi.setSystemTime(T0 + 3 * HOUR);
		expect(await drainDueJobs(h.repository, h.worker)).toBe(1);
		expect(h.take('scanFeedVideo')).toEqual([
			{task: 'scanFeedVideo', payload: {guid: 'a', attempt: 2}, options: early},
		]);
	});

	// one broken member can never be handed over, so it is dropped with an error instead of holding its minute.
	it('drops a malformed due job with an error and hands over the rest of its minute', async () => {
		const h = createHarness();
		const error = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'error');
		expect(await drainDueJobs(h.repository, h.worker)).toBe(0);
		const runAt = T0 + 5 * MINUTE;
		await h.repository.addDue('{"task":', runAt);
		await h.repository.addDue(JSON.stringify({task: 'noSuchTask', payload: {}, runAt}), runAt);
		const job = {runAt: new Date(runAt), jobKey: 'scan:a:2'};
		await deferLongWaits(h.worker, h.repository).addJob('scanFeedVideo', {guid: 'a', attempt: 2}, job);
		vi.setSystemTime(T0 + 6 * MINUTE);
		expect(await drainDueJobs(h.repository, h.worker)).toBe(3);
		expect(h.take('scanFeedVideo')).toEqual([{task: 'scanFeedVideo', payload: {guid: 'a', attempt: 2}, options: job}]);
		expect(h.jobs).toEqual([]);
		expect(error).toHaveBeenCalledTimes(2);
		expect(await h.repository.listDue(Math.floor(runAt / MINUTE), 10)).toEqual([]);
	});
});
