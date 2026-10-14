// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHmac} from 'node:crypto';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {Config, getConfig} from '@app/api/Config';
import {captureJobs, overrideLimits, type QueuedJob} from '@app/api/feed/tests/FeedTestUtils';
import {getMediaService} from '@app/api/middleware/ServiceRegistry';
import {getFeedRepository, getFeedVideoRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {BUNNY_TEST_SETTINGS, fakeBunnyStream} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import processFeedVideoWebhook from '@app/api/worker/tasks/ProcessFeedVideoWebhook';
import scanFeedVideo from '@app/api/worker/tasks/ScanFeedVideo';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {FeedVideoUploadResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
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

async function runQueued(jobs: Array<QueuedJob>, task: string, handler: WorkerTaskHandler): Promise<number> {
	const due = jobs.filter((job) => job.task === task);
	for (const job of due) {
		jobs.splice(jobs.indexOf(job), 1);
		await handler(job.payload, helpers);
	}
	return due.length;
}

function sign(raw: string, key = BUNNY_TEST_SETTINGS.readOnlyApiKey): string {
	return createHmac('sha256', key).update(raw).digest('hex');
}

function event(guid: string, status: number, libraryId = BUNNY_TEST_SETTINGS.libraryId): string {
	return JSON.stringify({VideoLibraryId: libraryId, VideoGuid: guid, Status: status});
}

describe('feed video webhook', () => {
	let harness: ApiTestHarness;
	const streamDefault = Config.bunnyStream;

	beforeAll(async () => {
		getConfig().bunnyStream = BUNNY_TEST_SETTINGS;
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
		await harness?.shutdown();
	});

	// Bunny's request: no session, the raw body and its three signature headers.
	async function send(
		raw: string,
		headers: Record<string, string | undefined> = {},
	): Promise<{status: number; json: {code?: string; received?: boolean}}> {
		const merged: Record<string, string | undefined> = {
			'x-bunnystream-signature': sign(raw),
			'x-bunnystream-signature-version': 'v1',
			'x-bunnystream-signature-algorithm': 'hmac-sha256',
			...headers,
		};
		const response = await harness.requestJson({
			path: '/feed/videos/webhook',
			method: 'POST',
			body: raw,
			headers: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as Record<
				string,
				string
			>,
		});
		const text = await response.text();
		return {status: response.status, json: text ? JSON.parse(text) : {}};
	}

	async function startVideo(): Promise<{guid: string; authorId: string}> {
		const alice = await createTestAccount(harness);
		overrideLimits({feature_feed_video: 1});
		const ticket = await createBuilder<FeedVideoUploadResponse>(harness, alice.token)
			.post('/feed/videos')
			.body({filename: 'clip.mp4', file_size: 1000, content_type: 'video/mp4', content: 'ilk video'})
			.execute();
		return {guid: ticket.id, authorId: alice.userId};
	}

	const webhookJobs = (jobs: Array<QueuedJob>) => jobs.filter((job) => job.task === 'processFeedVideoWebhook');

	it('refuses an unsigned or wrongly signed webhook with 401', async () => {
		const {guid} = await startVideo();
		const jobs = captureJobs();
		const raw = event(guid, 3);

		for (const signature of [
			undefined,
			'',
			sign(raw, 'another-key'),
			sign(event(guid, 4)),
			sign(raw).slice(0, 32),
			'z'.repeat(64),
		]) {
			const {status, json} = await send(raw, {'x-bunnystream-signature': signature});
			expect(status).toBe(HTTP_STATUS.UNAUTHORIZED);
			expect(json.code).toBe(APIErrorCodes.UNAUTHORIZED);
		}
		expect(jobs).toEqual([]);

		// No claim was taken: the signed delivery still goes through.
		expect((await send(raw)).status).toBe(HTTP_STATUS.OK);
		expect(webhookJobs(jobs)).toEqual([{task: 'processFeedVideoWebhook', payload: {guid}}]);
	});

	it('refuses another signature version or algorithm', async () => {
		const {guid} = await startVideo();
		const jobs = captureJobs();
		const raw = event(guid, 3);

		for (const headers of [
			{'x-bunnystream-signature-version': 'v2'},
			{'x-bunnystream-signature-version': undefined},
			{'x-bunnystream-signature-algorithm': 'hmac-sha512'},
			{'x-bunnystream-signature-algorithm': undefined},
		]) {
			expect((await send(raw, headers)).status).toBe(HTTP_STATUS.UNAUTHORIZED);
		}
		expect(jobs).toEqual([]);
	});

	it('refuses a body over 4 KiB', async () => {
		const {guid} = await startVideo();
		const jobs = captureJobs();
		const padded = JSON.stringify({
			VideoLibraryId: BUNNY_TEST_SETTINGS.libraryId,
			VideoGuid: guid,
			Status: 3,
			padding: 'x'.repeat(4096),
		});

		const tooLarge = await send(padded);
		expect(tooLarge.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(tooLarge.json.code).toBe(APIErrorCodes.INVALID_REQUEST);
		expect((await send(event(guid, 3), {'content-length': '4097'})).status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(jobs).toEqual([]);
	});

	it('stops reading a chunked body past 4 KiB instead of holding it all', async () => {
		await startVideo();
		const jobs = captureJobs();
		let pulled = 0;
		const kibibyte = new TextEncoder().encode('x'.repeat(1024));
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				if (pulled > 1000) controller.close();
				else controller.enqueue(kibibyte);
			},
		});
		const response = await harness.app.request('/feed/videos/webhook', {
			method: 'POST',
			body,
			duplex: 'half',
			headers: {
				'content-type': 'application/json',
				'x-forwarded-for': '127.0.0.1',
				'x-bunnystream-signature': sign('x'),
				'x-bunnystream-signature-version': 'v1',
				'x-bunnystream-signature-algorithm': 'hmac-sha256',
			},
		} as RequestInit);
		expect(response.status).toBe(HTTP_STATUS.BAD_REQUEST);
		expect(pulled).toBeLessThan(10);
		expect(jobs).toEqual([]);
	});

	it('acknowledges a signed body of an unknown shape, so Bunny does not retry it without end', async () => {
		await startVideo();
		const jobs = captureJobs();
		for (const raw of ['{"VideoGuid":', JSON.stringify({VideoLibraryId: 1, VideoGuid: 'x', Status: 3})]) {
			expect(await send(raw)).toEqual({status: HTTP_STATUS.OK, json: {received: true}});
		}
		expect(jobs).toEqual([]);
	});

	it('acknowledges another library’s webhook and an unknown status and does nothing', async () => {
		const {guid} = await startVideo();
		const jobs = captureJobs();

		for (const raw of [event(guid, 3, BUNNY_TEST_SETTINGS.libraryId + 1), event(guid, 11), event(guid, -1)]) {
			const {status, json} = await send(raw);
			expect(status).toBe(HTTP_STATUS.OK);
			expect(json).toEqual({received: true});
		}
		expect(jobs).toEqual([]);
		expect((await getFeedVideoRepository().get(guid))?.state).toBe('uploading');
	});

	it('queues one job for a replayed (guid, status) within 60 s', async () => {
		const {guid} = await startVideo();
		const jobs = captureJobs();

		expect(await send(event(guid, 3))).toEqual({status: HTTP_STATUS.OK, json: {received: true}});
		expect(await send(event(guid, 3))).toEqual({status: HTTP_STATUS.OK, json: {received: true}});
		expect(webhookJobs(jobs)).toHaveLength(1);

		expect((await send(event(guid, 4))).status).toBe(HTTP_STATUS.OK);
		expect(webhookJobs(jobs)).toEqual([
			{task: 'processFeedVideoWebhook', payload: {guid}},
			{task: 'processFeedVideoWebhook', payload: {guid}},
		]);
	});

	it('processes the same status again after the window without a second post', async () => {
		const {guid, authorId} = await startVideo();
		const media = getMediaService();
		const readFrame = media.getMetadata.bind(media);
		// The test media service scores nothing; a clean frame has a small non-zero NSFW probability.
		vi.spyOn(media, 'getMetadata').mockImplementation(async (request) => {
			const result = await readFrame(request);
			return result && {...result, nsfw_probability: 0.02};
		});
		const jobs = captureJobs();
		await fakeBunnyStream.finishVideo(guid, {length: 20});

		expect((await send(event(guid, 4))).status).toBe(HTTP_STATUS.OK);
		expect(await runQueued(jobs, 'processFeedVideoWebhook', processFeedVideoWebhook)).toBe(1);
		expect(await runQueued(jobs, 'scanFeedVideo', scanFeedVideo)).toBe(1);
		const published = await getFeedVideoRepository().get(guid);
		expect(published?.state).toBe('published');

		// The 60 s claim has run out.
		await getFeedVideoRepository().releaseWebhook(guid, 4);
		expect((await send(event(guid, 4))).status).toBe(HTTP_STATUS.OK);
		expect(await runQueued(jobs, 'processFeedVideoWebhook', processFeedVideoWebhook)).toBe(1);
		expect(await runQueued(jobs, 'scanFeedVideo', scanFeedVideo)).toBe(0);

		expect(await getFeedVideoRepository().get(guid)).toMatchObject({state: 'published', post_id: published!.post_id});
		expect(await getFeedRepository().listAuthorPostIds(createUserID(BigInt(authorId)), {limit: 10})).toEqual([
			published!.post_id,
		]);
	});

	it('answers 503 when Bunny Stream is not configured', async () => {
		const {guid} = await startVideo();
		const jobs = captureJobs();
		getConfig().bunnyStream = {...BUNNY_TEST_SETTINGS, enabled: false};

		const {status, json} = await send(event(guid, 3));

		expect(status).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
		expect(json.code).toBe(APIErrorCodes.SERVICE_UNAVAILABLE);
		expect(jobs).toEqual([]);
	});
});
