// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID, userIdToChannelId} from '@app/api/BrandedTypes';
import {Config, getConfig} from '@app/api/Config';
import {loadFixture} from '@app/api/channel/tests/AttachmentTestUtils';
import {leaveGuild, setupTestGuildWithMembers, updateUserSettings} from '@app/api/channel/tests/ChannelTestUtils';
import {feedDay} from '@app/api/feed/FeedRepository';
import {
	captureJobs,
	createPost,
	followDirectly,
	getHome,
	overrideLimits,
	runFanout,
	seedFollowers,
	setProfileLevel,
} from '@app/api/feed/tests/FeedTestUtils';
import {FOLLOWER_COUNT_COUNTER} from '@app/api/follow/FollowCounters';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getFeedInteractionService,
	getFeedRepository,
	getFeedTimelineService,
	getKVCounterService,
	getPurgeQueue,
	getUserRepository,
	getVirusScanServiceInstance,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {TestMediaService} from '@app/api/test/TestMediaService';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {collectUserHarvestExtensions, runUserDeletionHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ProfilePrivacyLevels, UserFlags} from '@fluxer/constants/src/UserConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ExplicitContentCannotBeSentError} from '@fluxer/errors/src/domains/moderation/ExplicitContentCannotBeSentError';
import type {FeedPostListResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {ClientUploadedAttachmentRequest} from '@fluxer/schema/src/domains/message/AttachmentSchemas';
import type {PresignedAttachmentUploadResponse} from '@fluxer/schema/src/domains/message/AttachmentUploadSchemas';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

const TOO_MANY_REQUESTS = 429;
const MAX_FEED_MEDIA_BYTES = 10 * 1024 * 1024;

describe('feed post routes', () => {
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

	function profilePosts(viewer: TestAccount, author: TestAccount) {
		return createBuilder<FeedPostListResponse>(harness, viewer.token).get(`/users/${author.userId}/posts`);
	}

	async function uploadImage(
		account: TestAccount,
		options: {data?: Buffer; announcedSize?: number} = {},
	): Promise<ClientUploadedAttachmentRequest> {
		const filename = 'photo.png';
		const data = options.data ?? loadFixture('yeah.png');
		const announcedSize = options.announcedSize ?? data.length;
		const {attachments} = await createBuilder<PresignedAttachmentUploadResponse>(harness, account.token)
			.post('/feed/attachments')
			.body({attachments: [{id: 7, filename, file_size: announcedSize, content_type: 'image/png'}]})
			.execute();
		const planned = attachments[0]!;
		expect(planned).toMatchObject({id: 7, upload_mode: 'singlepart', filename});
		await harness.storageService.uploadObject({
			bucket: Config.s3.buckets.uploads,
			key: planned.upload_filename,
			body: data,
			contentType: 'image/png',
		});
		return {
			id: 0,
			filename,
			upload_filename: planned.upload_filename,
			file_size: announcedSize,
			content_type: 'image/png',
			flags: 0,
		};
	}

	it('creates, reads and deletes a text post', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;

		const post = await createPost(harness, alice, {content: 'Merhaba akış'}).execute();
		expect(post).toMatchObject({
			content: 'Merhaba akış',
			attachments: [],
			edited_at: null,
			like_count: 0,
			comment_count: 0,
			liked: false,
		});
		expect(post.author.id).toBe(alice.userId);

		expect(await createBuilder<FeedPostResponse>(harness, bob.token).get(`/feed/posts/${post.id}`).execute()).toEqual(
			post,
		);
		expect((await profilePosts(bob, alice).execute()).map((entry) => entry.id)).toEqual([post.id]);

		await createBuilder(harness, bob.token)
			.delete(`/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_PERMISSIONS)
			.execute();
		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();

		await createBuilder(harness, bob.token)
			.get(`/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
		await createBuilder(harness, alice.token)
			.delete(`/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
		expect(await profilePosts(bob, alice).execute()).toEqual([]);
	});

	it('does not let a read that raced a delete put the deleted post back in the cache', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'yarış'}).execute();
		const postId = BigInt(post.id);
		await getKVClient().del(`feed:post:${post.id}`);

		// The first feed_posts read (the racing reader) is held after it got the row, before it fills the cache.
		const execute = InMemoryCassandraQueryExecutor.prototype.executeQuery;
		let rowRead!: () => void;
		const readerHasRow = new Promise<void>((resolve) => {
			rowRead = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let held = false;
		vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeQuery').mockImplementation(async function (
			this: InMemoryCassandraQueryExecutor,
			query,
		) {
			const result = await execute.call(this, query);
			if (!held && /^SELECT .* FROM feed_posts /i.test(query.cql)) {
				held = true;
				rowRead();
				await released;
			}
			return result;
		} as typeof execute);

		const racingRead = getFeedRepository().getPost(postId);
		await readerHasRow;
		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();
		release();
		expect(await racingRead).not.toBeNull();

		expect(await getFeedRepository().getPost(postId)).toBeNull();
		await createBuilder(harness, alice.token)
			.get(`/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
	});

	it('refuses an empty post', async () => {
		const alice = await createTestAccount(harness);
		await createPost(harness, alice, {})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CANNOT_SEND_EMPTY_MESSAGE)
			.execute();
	});

	it('includes the author in their own home feed', async () => {
		const alice = await createTestAccount(harness);
		const first = await createPost(harness, alice, {content: 'bir'}).execute();
		const second = await createPost(harness, alice, {content: 'iki'}).execute();

		expect((await getHome(harness, alice).execute()).map((entry) => entry.id)).toEqual([second.id, first.id]);
		expect((await getHome(harness, alice, `?before=${second.id}`).execute()).map((entry) => entry.id)).toEqual([
			first.id,
		]);
		expect(await getHome(harness, alice, `?before=${first.id}`).execute()).toEqual([]);
	});

	it('posts images through the attachment upload path under the author key and purges them on delete', async () => {
		const alice = await createTestAccount(harness);
		const attachment = await uploadImage(alice);

		const post = await createPost(harness, alice, {content: 'foto', attachments: [attachment]}).execute();
		expect(post.attachments).toHaveLength(1);
		const media = post.attachments[0]!;
		expect(media).toMatchObject({filename: 'photo.png', content_type: 'image/png'});
		const cdnKey = `attachments/${userIdToChannelId(createUserID(BigInt(alice.userId)))}/${media.id}/photo.png`;
		expect(media.url).toContain(`/${cdnKey}?`);
		expect(media.proxy_url).toBe(media.url);
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, cdnKey)).not.toBeNull();

		// An upload is consumed by one post.
		await createPost(harness, alice, {attachments: [attachment]})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();

		const purge = vi.spyOn(getPurgeQueue(), 'addUrls');
		await createBuilder(harness, alice.token).delete(`/feed/posts/${post.id}`).expect(HTTP_STATUS.NO_CONTENT).execute();
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, cdnKey)).toBeNull();
		expect(purge).toHaveBeenCalledWith([`${Config.endpoints.media}/${cdnKey}`]);
	});

	it('accepts only PNG, JPEG, WebP and GIF by sniffed content, with metadata, up to 10 MB', async () => {
		const alice = await createTestAccount(harness);

		const svgPlan = await createBuilder(harness, alice.token)
			.post('/feed/attachments')
			.body({attachments: [{id: 0, filename: 'logo.svg', file_size: 100, content_type: 'image/svg+xml'}]})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		expect(JSON.stringify(svgPlan)).toContain(ValidationErrorCodes.ATTACHMENT_MUST_BE_IMAGE);
		await createBuilder(harness, alice.token)
			.post('/feed/attachments')
			.body({
				attachments: [{id: 0, filename: 'big.png', file_size: MAX_FEED_MEDIA_BYTES + 1, content_type: 'image/png'}],
			})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.FILE_SIZE_TOO_LARGE)
			.execute();
		await createBuilder(harness, alice.token)
			.post('/feed/attachments')
			.body({
				attachments: Array.from({length: 5}, (_, id) => ({
					id,
					filename: `${id}.png`,
					file_size: 10,
					content_type: 'image/png',
				})),
			})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();

		// A .png name over SVG bytes: the media proxy sniffs the bytes, and the sniffed type decides.
		const disguised = await uploadImage(alice);
		vi.spyOn(TestMediaService.prototype, 'getMetadata').mockResolvedValueOnce({
			format: 'svg',
			content_type: 'image/svg+xml',
			content_hash: 'svg-hash',
			size: 100,
			nsfw: false,
		});
		const svgPost = await createPost(harness, alice, {attachments: [disguised]})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		expect(JSON.stringify(svgPost)).toContain(ValidationErrorCodes.ATTACHMENT_MUST_BE_IMAGE);

		// Image bytes under a name that would end the CDN key in .html.
		const renamed = await uploadImage(alice);
		const renamedPost = await createPost(harness, alice, {attachments: [{...renamed, filename: 'page.html'}]})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY)
			.execute();
		expect(JSON.stringify(renamedPost)).toContain(ValidationErrorCodes.ATTACHMENT_MUST_BE_IMAGE);

		// The message path keeps a file without metadata as a plain file; the feed refuses it.
		const unreadable = await uploadImage(alice);
		vi.spyOn(TestMediaService.prototype, 'getMetadata').mockResolvedValueOnce(null);
		await createPost(harness, alice, {attachments: [unreadable]})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.MEDIA_METADATA_ERROR)
			.execute();

		const explicit = await uploadImage(alice);
		vi.spyOn(TestMediaService.prototype, 'getMetadata').mockRejectedValueOnce(
			new ExplicitContentCannotBeSentError(0.97),
		);
		await createPost(harness, alice, {attachments: [explicit]})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.EXPLICIT_CONTENT_CANNOT_BE_SENT)
			.execute();

		// A client that announced a small file and uploaded a larger one.
		const oversized = await uploadImage(alice, {data: Buffer.alloc(MAX_FEED_MEDIA_BYTES + 1), announcedSize: 100});
		await createPost(harness, alice, {attachments: [oversized]})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.FILE_SIZE_TOO_LARGE)
			.execute();

		expect(await profilePosts(alice, alice).execute()).toEqual([]);
	});

	it('refuses an image the virus scan flags and deletes the upload', async () => {
		const alice = await createTestAccount(harness);
		const infected = await uploadImage(alice);
		const scanner = getVirusScanServiceInstance() as {enabled: boolean};
		const scanFile = vi
			.spyOn(getVirusScanServiceInstance(), 'scanFile')
			.mockResolvedValue({isClean: false, fileHash: 'eicar'});
		scanner.enabled = true;
		try {
			await createPost(harness, alice, {content: 'virüslü', attachments: [infected]})
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.CONTENT_BLOCKED)
				.execute();
		} finally {
			scanner.enabled = false;
		}
		expect(scanFile).toHaveBeenCalledOnce();
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.uploads, infected.upload_filename)).toBe(
			null,
		);
		expect(await profilePosts(alice, alice).execute()).toEqual([]);
	});

	it('refuses feed uploads while the instance has presigned uploads off', async () => {
		const alice = await createTestAccount(harness);
		getConfig().presignedAttachmentUploadsEnabled = false;
		try {
			await createBuilder(harness, alice.token)
				.post('/feed/attachments')
				.body({attachments: [{id: 0, filename: 'a.png', file_size: 10, content_type: 'image/png'}]})
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED)
				.execute();
		} finally {
			getConfig().presignedAttachmentUploadsEnabled = true;
		}
	});

	it('answers 403 on every route and stops fan-out jobs while feature_feed is 0', async () => {
		const alice = await createTestAccount(harness);
		const jobs = captureJobs();
		const followers = await seedFollowers(alice.userId, 3);
		const post = await createPost(harness, alice, {content: 'kapanmadan önce'}).execute();

		overrideLimits({feature_feed: 0});
		const routes: ReadonlyArray<readonly ['get' | 'post' | 'delete', string, object | null]> = [
			[
				'post',
				'/feed/attachments',
				{attachments: [{id: 0, filename: 'a.png', file_size: 10, content_type: 'image/png'}]},
			],
			['post', '/feed/posts', {content: 'Merhaba'}],
			['get', `/feed/posts/${post.id}`, null],
			['delete', `/feed/posts/${post.id}`, null],
			['get', '/feed/home?limit=50', null],
			['get', `/users/${alice.userId}/posts`, null],
		];
		for (const [method, path, body] of routes) {
			const builder = createBuilder(harness, alice.token)[method](path);
			if (body) builder.body(body);
			await builder.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.FEATURE_TEMPORARILY_DISABLED).execute();
		}

		expect(await runFanout(jobs)).toBe(1);
		for (const follower of followers) {
			expect(await getFeedRepository().listHome(follower, feedDay(BigInt(post.id)), undefined, 10)).toEqual([]);
		}
	});

	// a post whose author is disabled before its fan-out (a ban while a video was scanned) reaches no home feed.
	it('stops fan-out jobs for a disabled author', async () => {
		const alice = await createTestAccount(harness);
		const jobs = captureJobs();
		const followers = await seedFollowers(alice.userId, 3);
		const post = await createPost(harness, alice, {content: 'yasaktan önce'}).execute();
		const aliceId = createUserID(BigInt(alice.userId));
		const user = (await getUserRepository().findUnique(aliceId))!;
		await getUserRepository().patchUpsert(aliceId, {flags: user.flags | UserFlags.DISABLED}, user.toRow());

		expect(await runFanout(jobs)).toBe(1);
		for (const follower of followers) {
			expect(await getFeedRepository().listHome(follower, feedDay(BigInt(post.id)), undefined, 10)).toEqual([]);
		}
	});

	it('refuses posts past max_feed_posts_per_day with 429', async () => {
		const alice = await createTestAccount(harness);
		overrideLimits({max_feed_posts_per_day: 2});
		await createPost(harness, alice, {content: '1'}).execute();
		await createPost(harness, alice, {content: '2'}).execute();
		await createPost(harness, alice, {content: '3'}).expect(TOO_MANY_REQUESTS, APIErrorCodes.RATE_LIMITED).execute();
	});

	it('fans a post out to 300 followers on the feed lane, never on the request path', async () => {
		const alice = await createTestAccount(harness);
		const followers = await seedFollowers(alice.userId, 300);
		const jobs = captureJobs();

		const post = await createPost(harness, alice, {content: 'herkese'}).execute();
		const day = feedDay(BigInt(post.id));
		expect(jobs.map((job) => job.task)).toEqual(['fanoutFeedPost']);
		expect(await getFeedRepository().listHome(followers[0]!, day, undefined, 10)).toEqual([]);

		// One page of 300, then an empty page that ends the chain.
		expect(await runFanout(jobs)).toBe(2);
		let rows = 0;
		for (const follower of followers) {
			const homeRows = await getFeedRepository().listHome(follower, day, undefined, 10);
			expect(homeRows.map((row) => row.post_id.toString())).toEqual([post.id]);
			rows += homeRows.length;
		}
		expect(rows).toBe(300);
	});

	it('writes only feed_fanout_max_posts_per_day posts a day to home feeds and keeps the rest on the profile', async () => {
		const alice = await createTestAccount(harness);
		await seedFollowers(alice.userId, 2);
		overrideLimits({feed_fanout_max_posts_per_day: 1});
		const jobs = captureJobs();

		const first = await createPost(harness, alice, {content: 'ilk'}).execute();
		const second = await createPost(harness, alice, {content: 'ikinci'}).execute();

		expect(jobs.map((job) => job.payload.postId)).toEqual([first.id]);
		expect((await profilePosts(alice, alice).execute()).map((entry) => entry.id)).toEqual([second.id, first.id]);
	});

	it('drops a deleted post and an unfollowed author from the home feed', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		await createBuilder(harness, bob.token)
			.put(`/users/${alice.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		// Another followed account keeps Bob's following list non-empty after he unfollows Alice.
		await followDirectly(bob.userId, (await getSnowflakeService().generate()).toString());
		const jobs = captureJobs();

		const kept = await createPost(harness, alice, {content: 'kalıyor'}).execute();
		const removed = await createPost(harness, alice, {content: 'siliniyor'}).execute();
		await runFanout(jobs);
		expect((await getHome(harness, bob).execute()).map((entry) => entry.id)).toEqual([removed.id, kept.id]);

		await createBuilder(harness, alice.token)
			.delete(`/feed/posts/${removed.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect((await getHome(harness, bob).execute()).map((entry) => entry.id)).toEqual([kept.id]);

		await createBuilder(harness, bob.token)
			.delete(`/users/${alice.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(await getHome(harness, bob).execute()).toEqual([]);
	});

	it('shows posts only to accounts that may see the profile (S-2)', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const stranger = await createTestAccount(harness);
		await setProfileLevel(alice, ProfilePrivacyLevels.ALL_GUILDS); // a post not marked public
		const post = await createPost(harness, alice, {content: 'yalnız tanıdıklara'}).execute();

		for (const path of [`/users/${alice.userId}/posts`, `/feed/posts/${post.id}`]) {
			await createBuilder(harness, stranger.token)
				.get(path)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
			await createBuilder(harness, bob.token).get(path).expect(HTTP_STATUS.OK).execute();
		}

		await updateUserSettings(harness, alice.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});
		for (const path of [`/users/${alice.userId}/posts`, `/feed/posts/${post.id}`]) {
			await createBuilder(harness, bob.token)
				.get(path)
				.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
				.execute();
		}
		await profilePosts(alice, alice).expect(HTTP_STATUS.OK).execute();
	});

	it('drops from the home feed an author who left the shared community, and still fills the page (S-2)', async () => {
		const {owner: carol, members, guild} = await setupTestGuildWithMembers(harness, 2);
		const [alice, bob] = [members[0]!, members[1]!];
		for (const author of [alice, carol]) {
			await createBuilder(harness, bob.token)
				.put(`/users/${author.userId}/follow`)
				.expect(HTTP_STATUS.NO_CONTENT)
				.execute();
		}
		const jobs = captureJobs();
		const kept = await createPost(harness, carol, {content: 'görünür'}).execute();
		await leaveGuild(harness, alice.token, guild.id);
		const hidden = await createPost(harness, alice, {content: 'sunucudan çıktıktan sonra'}).execute();
		await runFanout(jobs);
		const bobHome = await getFeedRepository().listHome(
			createUserID(BigInt(bob.userId)),
			feedDay(BigInt(hidden.id)),
			undefined,
			10,
		);
		expect(bobHome.map((row) => row.post_id.toString())).toContain(hidden.id);

		expect((await getHome(harness, bob, '?limit=1').execute()).map((entry) => entry.id)).toEqual([kept.id]);
		await profilePosts(bob, alice).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
	});

	it('drops from the home feed a pulled author whose profile turned friends only (S-2)', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		await createBuilder(harness, bob.token)
			.put(`/users/${alice.userId}/follow`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		await getKVCounterService().add(FOLLOWER_COUNT_COUNTER, alice.userId, 20_000);
		await updateUserSettings(harness, alice.token, {profile_privacy: ProfilePrivacyLevels.FRIENDS_ONLY});
		await createPost(harness, alice, {content: 'yalnız arkadaşlara'}).execute();
		await getFeedTimelineService().refreshCelebrities();

		expect(await getHome(harness, bob).execute()).toEqual([]);
		await profilePosts(bob, alice).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
	});

	it("reads the viewer's likes and votes beside the base of the responses, not after it", async () => {
		const author = await createTestAccount(harness);
		const post = await createPost(harness, author, {content: 'yan yana'}).execute();
		const row = (await getFeedRepository().getPost(BigInt(post.id)))!;
		const interactions = getFeedInteractionService();
		const counts = interactions.getPostCounts.bind(interactions);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.spyOn(interactions, 'getPostCounts').mockImplementation(async (rows) => {
			await held;
			return counts(rows);
		});
		const states = vi.spyOn(interactions, 'getViewerStates');

		const pending = getFeedTimelineService().toResponses(
			[row],
			createRequestCache(),
			createUserID(BigInt(author.userId)),
		);
		try {
			await vi.waitFor(() => expect(states).toHaveBeenCalled(), {timeout: 500});
		} finally {
			release();
		}
		expect((await pending)[0]).toMatchObject({id: post.id, liked: false});
	});

	it('deletes the posts and media of a deleted account, idempotently, and exports them', async () => {
		const alice = await createTestAccount(harness);
		const aliceId = createUserID(BigInt(alice.userId));
		const attachment = await uploadImage(alice);
		const withImage = await createPost(harness, alice, {content: 'resimli', attachments: [attachment]}).execute();
		const plain = await createPost(harness, alice, {content: 'düz'}).execute();

		const feedExport = (await collectUserHarvestExtensions({userId: aliceId})).find((entry) => entry.name === 'feed');
		expect(feedExport?.data).toMatchObject({
			posts: [
				{id: plain.id, content: 'düz', attachments: []},
				{id: withImage.id, content: 'resimli', attachments: [{filename: 'photo.png', content_type: 'image/png'}]},
			],
		});

		const cdnKey = `attachments/${userIdToChannelId(aliceId)}/${withImage.attachments[0]!.id}/photo.png`;
		const purge = vi.spyOn(getPurgeQueue(), 'addUrls');
		await runUserDeletionHook('feed', {userId: aliceId});
		await runUserDeletionHook('feed', {userId: aliceId});

		expect(await getFeedRepository().getPost(BigInt(withImage.id))).toBeNull();
		expect(await getFeedRepository().getPost(BigInt(plain.id))).toBeNull();
		expect(await getFeedRepository().listAuthorPostIds(aliceId, {limit: 10})).toEqual([]);
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, cdnKey)).toBeNull();
		expect(purge).toHaveBeenCalledWith([`${Config.endpoints.media}/${cdnKey}`]);
	});
});
