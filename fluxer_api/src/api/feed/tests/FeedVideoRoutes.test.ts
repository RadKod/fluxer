// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, userIdToChannelId} from '@app/api/BrandedTypes';
import {Config, getConfig} from '@app/api/Config';
import {getContentType} from '@app/api/channel/services/message/MessageHelpers';
import {loadFixture} from '@app/api/channel/tests/AttachmentTestUtils';
import {createPost, overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {TestMediaService} from '@app/api/test/TestMediaService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import type {FeedPostListResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {ClientUploadedAttachmentRequest} from '@fluxer/schema/src/domains/message/AttachmentSchemas';
import type {PresignedAttachmentUploadResponse} from '@fluxer/schema/src/domains/message/AttachmentUploadSchemas';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const MB = 1024 * 1024;

// The media proxy video path is gone: a video reaches the feed only through Bunny Stream (POST /feed/videos).
// The image routes still refuse video names: 403 for mp4/webm while feature_feed_video is 0 (as before), 400 once
// it is 1, and 400 for every other type either way.
describe('feed video routes', () => {
	let harness: ApiTestHarness;
	const presignedDefault = Config.presignedAttachmentUploadsEnabled;

	beforeAll(async () => {
		harness = await createApiTestHarness();
		getConfig().presignedAttachmentUploadsEnabled = true;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		getConfig().presignedAttachmentUploadsEnabled = presignedDefault;
		await harness?.shutdown();
	});

	function plan(account: TestAccount, files: Array<{filename: string; file_size: number}>) {
		return createBuilder<PresignedAttachmentUploadResponse>(harness, account.token)
			.post('/feed/attachments')
			.body({attachments: files.map((file, id) => ({id, ...file, content_type: getContentType(file.filename)}))});
	}

	// An image upload the client may then name anything when it posts.
	async function upload(account: TestAccount): Promise<ClientUploadedAttachmentRequest> {
		const data = loadFixture('yeah.png');
		const {attachments} = await plan(account, [{filename: 'photo.png', file_size: data.length}]).execute();
		const planned = attachments[0]!;
		await harness.storageService.uploadObject({
			bucket: Config.s3.buckets.uploads,
			key: planned.upload_filename,
			body: data,
			contentType: planned.content_type,
		});
		return {
			id: 0,
			filename: 'photo.png',
			upload_filename: planned.upload_filename,
			file_size: data.length,
			content_type: planned.content_type,
			flags: 0,
		};
	}

	async function cdnKeys(account: TestAccount): Promise<Array<string>> {
		const channelId = userIdToChannelId(createUserID(BigInt(account.userId)));
		const objects = await harness.storageService.listObjects({
			bucket: Config.s3.buckets.cdn,
			prefix: `attachments/${channelId}/`,
		});
		return objects.map(({key}) => key);
	}

	function profilePosts(account: TestAccount) {
		return createBuilder<FeedPostListResponse>(harness, account.token).get(`/users/${account.userId}/posts`);
	}

	async function expectNotAnImage(request: {execute(): Promise<unknown>}): Promise<void> {
		expect(JSON.stringify(await request.execute())).toContain(ValidationErrorCodes.ATTACHMENT_MUST_BE_IMAGE);
	}

	it('refuses an mp4 or webm file with 403 while feature_feed_video is 0 (unchanged)', async () => {
		const alice = await createTestAccount(harness);
		for (const files of [
			[{filename: 'clip.mp4', file_size: 2048}],
			[{filename: 'clip.webm', file_size: 2048}],
			[
				{filename: 'photo.png', file_size: 10},
				{filename: 'clip.mp4', file_size: 10},
			],
		]) {
			await plan(alice, files).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
		}

		// A client that planned an image and names the upload a video when posting is refused on the post route too.
		const planned = await upload(alice);
		for (const filename of ['clip.mp4', 'clip.webm']) {
			await createPost(harness, alice, {content: 'video', attachments: [{...planned, filename}]})
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
				.execute();
		}
		expect(await cdnKeys(alice)).toEqual([]);
		expect(await profilePosts(alice).execute()).toEqual([]);
	});

	it('refuses them with 400 on /feed/attachments and /feed/posts while it is 1', async () => {
		overrideLimits({feature_feed_video: 1});
		const alice = await createTestAccount(harness);

		for (const filename of ['clip.mp4', 'clip.webm']) {
			await expectNotAnImage(
				plan(alice, [{filename, file_size: 2048}]).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY),
			);
			const planned = await upload(alice);
			await expectNotAnImage(
				createPost(harness, alice, {attachments: [{...planned, filename}]}).expect(
					HTTP_STATUS.BAD_REQUEST,
					APIErrorCodes.INVALID_FORM_BODY,
				),
			);
		}

		// An image name over video bytes: the media proxy sniffs a video and the image path refuses it.
		const disguised = await upload(alice);
		vi.spyOn(TestMediaService.prototype, 'getMetadata').mockResolvedValueOnce({
			format: 'mp4',
			content_type: 'video/mp4',
			content_hash: 'video-hash',
			size: 2048,
			width: 640,
			height: 360,
			duration: 30,
			nsfw: false,
		});
		await expectNotAnImage(
			createPost(harness, alice, {attachments: [disguised]}).expect(
				HTTP_STATUS.BAD_REQUEST,
				APIErrorCodes.INVALID_FORM_BODY,
			),
		);

		expect(await cdnKeys(alice)).toEqual([]);
		expect(await profilePosts(alice).execute()).toEqual([]);
	});

	it('a mov file stays a 400 either way', async () => {
		const alice = await createTestAccount(harness);
		for (const flag of [0, 1]) {
			overrideLimits({feature_feed_video: flag});
			for (const filename of ['clip.mov', 'clip.mkv']) {
				await expectNotAnImage(
					plan(alice, [{filename, file_size: 2048}]).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY),
				);
				const planned = await upload(alice);
				await expectNotAnImage(
					createPost(harness, alice, {attachments: [{...planned, filename}]}).expect(
						HTTP_STATUS.BAD_REQUEST,
						APIErrorCodes.INVALID_FORM_BODY,
					),
				);
			}
		}
		expect(await cdnKeys(alice)).toEqual([]);
	});

	it('images still work exactly as before', async () => {
		const alice = await createTestAccount(harness);
		for (const flag of [0, 1]) {
			overrideLimits({feature_feed_video: flag});
			await plan(alice, [{filename: 'big.png', file_size: 10 * MB + 1}])
				.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.FILE_SIZE_TOO_LARGE)
				.execute();
			const refused = await plan(alice, [{filename: 'logo.svg', file_size: 100}])
				.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
			expect(JSON.stringify(refused)).toContain(ValidationErrorCodes.ATTACHMENT_MUST_BE_IMAGE);

			// An image whose metadata could not be stripped is kept, as it always was.
			const photo = await upload(alice);
			vi.spyOn(harness.storageService, 'copyObjectWithMetadataStripping').mockImplementationOnce(async (params) => {
				await harness.storageService.copyObject({
					sourceBucket: params.sourceBucket,
					sourceKey: params.sourceKey,
					destinationBucket: params.destinationBucket,
					destinationKey: params.destinationKey,
					newContentType: params.contentType,
				});
				return null;
			});
			const post = await createPost(harness, alice, {attachments: [photo]}).execute();
			expect(post.attachments[0]).toMatchObject({filename: 'photo.png', content_type: 'image/png', duration: null});
			expect(post.video).toBeUndefined();
		}
	});
});
