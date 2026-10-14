// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config, getConfig} from '@app/api/Config';
import {captureJobs, overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {signTusUpload} from '@app/api/feed/video/FeedVideoUrls';
import {getFeedVideoRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {BUNNY_TEST_SETTINGS, fakeBunnyStream} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import deleteFeedVideo from '@app/api/worker/tasks/DeleteFeedVideo';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {FEED_VIDEO_MAX_BYTES} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import type {
	FeedPendingVideoListResponse,
	FeedVideoUploadResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const helpers: WorkerTaskHelpers = {
	logger: new NoopLogger(),
	jobId: 1n,
	addJob: async () => 0n,
	reportProgress: async () => {},
	shouldCancel: async () => false,
	setContextLink: async () => {},
};

const SECRETS = [
	BUNNY_TEST_SETTINGS.apiKey,
	BUNNY_TEST_SETTINGS.readOnlyApiKey,
	BUNNY_TEST_SETTINGS.tokenKey,
	BUNNY_TEST_SETTINGS.storagePassword,
];

describe('feed video upload routes', () => {
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

	function startUpload(account: TestAccount, body: Record<string, unknown> = {}) {
		return createBuilder<FeedVideoUploadResponse>(harness, account.token)
			.post('/feed/videos')
			.body({filename: 'clip.mp4', file_size: 1000, content_type: 'video/mp4', content: 'ilk video', ...body});
	}

	function resign(account: TestAccount, videoId: string) {
		return createBuilder<FeedVideoUploadResponse>(harness, account.token).post(`/feed/videos/${videoId}/signature`);
	}

	function listVideos(account: TestAccount) {
		return createBuilder<FeedPendingVideoListResponse>(harness, account.token).get('/feed/videos');
	}

	it('answers 403 while feature_feed_video is 0 and while Bunny Stream is not fully configured', async () => {
		const alice = await createTestAccount(harness);

		await startUpload(alice).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();

		overrideLimits({feature_feed_video: 1});
		getConfig().bunnyStream = {...BUNNY_TEST_SETTINGS, enabled: false};
		await startUpload(alice).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();

		expect(fakeBunnyStream.getCalls()).toEqual([]);
	});

	it('starts an upload and returns the TUS ticket without any Bunny key', async () => {
		const alice = await createTestAccount(harness);
		overrideLimits({feature_feed_video: 1});

		const {response, text, json: ticket} = await startUpload(alice).executeRaw();

		expect(response.status).toBe(HTTP_STATUS.OK);
		expect(ticket.library_id).toBe(String(BUNNY_TEST_SETTINGS.libraryId));
		expect(ticket.upload.endpoint).toBe(BUNNY_TEST_SETTINGS.tusEndpoint);
		expect(ticket.upload.signature).toBe(signTusUpload(BUNNY_TEST_SETTINGS, ticket.id, ticket.upload.expires));
		expect(fakeBunnyStream.getVideo(ticket.id)).not.toBeNull();
		expect(await getFeedVideoRepository().get(ticket.id)).toMatchObject({
			author_id: BigInt(alice.userId),
			state: 'uploading',
			content: 'ilk video',
			content_type: 'video/mp4',
			declared_size: 1000n,
		});
		for (const secret of SECRETS) {
			expect(text).not.toContain(secret);
		}
	});

	it('refuses 500 MB + 1 byte and a GIF content type', async () => {
		const alice = await createTestAccount(harness);
		overrideLimits({feature_feed_video: 1});

		await startUpload(alice, {file_size: FEED_VIDEO_MAX_BYTES + 1})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		await startUpload(alice, {filename: 'clip.gif', content_type: 'image/gif'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		expect(fakeBunnyStream.getCalls()).toEqual([]);

		await startUpload(alice, {file_size: FEED_VIDEO_MAX_BYTES}).execute();
	});

	it('re-signs only the caller’s uploading video', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		overrideLimits({feature_feed_video: 1});
		const {id} = await startUpload(alice).execute();

		const ticket = await resign(alice, id).execute();
		expect(ticket.id).toBe(id);
		expect(ticket.upload.signature).toBe(signTusUpload(BUNNY_TEST_SETTINGS, id, ticket.upload.expires));

		await resign(bob, id).expect(HTTP_STATUS.NOT_FOUND).execute();
		await resign(alice, randomUUID()).expect(HTTP_STATUS.NOT_FOUND).execute();
		await resign(alice, 'not-a-video').expect(HTTP_STATUS.BAD_REQUEST).execute();

		const repository = getFeedVideoRepository();
		const token = (await repository.lockVideo(id))!;
		await resign(alice, id).expect(HTTP_STATUS.CONFLICT).execute();
		await repository.update(id, {state: 'processing'});
		await repository.unlockVideo(id, token);
		await resign(alice, id).expect(HTTP_STATUS.NOT_FOUND).execute();
	});

	it('cancels an in-flight video and deletes it from Bunny', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		overrideLimits({feature_feed_video: 1});
		const {id} = await startUpload(alice).execute();
		const jobs = captureJobs();

		await createBuilder(harness, bob.token).delete(`/feed/videos/${id}`).expect(HTTP_STATUS.NOT_FOUND).execute();
		const repository = getFeedVideoRepository();
		const token = (await repository.lockVideo(id))!;
		await createBuilder(harness, alice.token).delete(`/feed/videos/${id}`).expect(HTTP_STATUS.CONFLICT).execute();
		await repository.unlockVideo(id, token);
		expect(jobs).toEqual([]);

		await createBuilder(harness, alice.token).delete(`/feed/videos/${id}`).expect(HTTP_STATUS.NO_CONTENT).execute();

		expect((await repository.get(id))?.state).toBe('deleting');
		expect(await listVideos(alice).execute()).toEqual([]);
		const deletes = jobs.filter((job) => job.task === 'deleteFeedVideo');
		expect(deletes).toEqual([{task: 'deleteFeedVideo', payload: {guid: id}}]);
		await deleteFeedVideo(deletes[0]!.payload, helpers);
		expect(fakeBunnyStream.getVideo(id)).toBeNull();
		expect(await repository.get(id)).toBeNull();
		await createBuilder(harness, alice.token).delete(`/feed/videos/${id}`).expect(HTTP_STATUS.NOT_FOUND).execute();
	});

	it('lists only the caller’s videos', async () => {
		const alice = await createTestAccount(harness);
		const bob = await createTestAccount(harness);
		overrideLimits({feature_feed_video: 1});
		const first = await startUpload(alice).execute();
		const second = await startUpload(alice).execute();
		const other = await startUpload(bob).execute();

		const aliceVideos = await listVideos(alice).execute();
		expect(aliceVideos.map((video) => video.id).sort()).toEqual([first.id, second.id].sort());
		expect(aliceVideos.every((video) => video.state === 'uploading' && video.post_id === null)).toBe(true);
		expect((await listVideos(bob).execute()).map((video) => video.id)).toEqual([other.id]);
	});
});
