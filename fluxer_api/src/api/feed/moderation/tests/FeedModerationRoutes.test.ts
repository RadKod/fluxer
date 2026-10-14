// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createAttachmentID, createReportID, createUserID, userIdToChannelId} from '@app/api/BrandedTypes';
import {Config, getConfig} from '@app/api/Config';
import {loadFixture} from '@app/api/channel/tests/AttachmentTestUtils';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {NcmecSubmissionService} from '@app/api/csam/NcmecSubmissionService';
import type {NcmecAttachmentSubmissionRow, NcmecUserWorkflowRow} from '@app/api/database/types/CsamTypes';
import type {FeedMedia, FeedPostRow} from '@app/api/database/types/FeedTypes';
import {sendFeedAuthorDm} from '@app/api/feed/FeedAuthorDm';
import {
	captureJobs,
	createPost,
	followDirectly,
	getHome,
	type QueuedJob,
	runFanout,
} from '@app/api/feed/tests/FeedTestUtils';
import {feedStreamEvidenceKey} from '@app/api/feed/video/FeedVideoUrls';
import {Logger} from '@app/api/Logger';
import {getKVClient, getSnowflakeService} from '@app/api/middleware/ServiceRegistry';
import {
	getAdminRepository,
	getChannelRepository,
	getFeedDiscoverRepository,
	getFeedPostService,
	getFeedVideoRepository,
	getPurgeQueue,
	getReportRepository,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {BUNNY_TEST_SETTINGS, fakeBunnyStream} from '@app/api/test/msw/handlers/BunnyStreamHandlers';
import {fakeNcmecServer} from '@app/api/test/Setup';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import deleteFeedVideo from '@app/api/worker/tasks/DeleteFeedVideo';
import keepFeedVideoEvidence from '@app/api/worker/tasks/KeepFeedVideoEvidence';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {FeedCommentListResponse, FeedCommentResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import type {ClientUploadedAttachmentRequest} from '@fluxer/schema/src/domains/message/AttachmentSchemas';
import type {PresignedAttachmentUploadResponse} from '@fluxer/schema/src/domains/message/AttachmentUploadSchemas';
import type {ReportResponse} from '@fluxer/schema/src/domains/report/ReportSchemas';
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

// Runs the queued jobs of one task the way the video lane would, taking them off the list.
async function runQueued(jobs: Array<QueuedJob>, task: string, handler: WorkerTaskHandler): Promise<number> {
	const due = jobs.filter((job) => job.task === task);
	for (const job of due) {
		jobs.splice(jobs.indexOf(job), 1);
		await handler(job.payload, helpers);
	}
	return due.length;
}

interface AdminReport {
	report_type: number;
	reported_user_id: string | null;
	reported_message_id: string | null;
	message_context: Array<{
		id: string;
		channel_id: string;
		author_id: string;
		content: string;
		attachments: Array<{id: string; filename: string; ncmec_status: string}>;
	}>;
}

describe('feed reports and moderation', () => {
	let harness: ApiTestHarness;
	const presignedDefault = getConfig().presignedAttachmentUploadsEnabled;
	const streamDefault = getConfig().bunnyStream;

	beforeAll(async () => {
		getConfig().bunnyStream = BUNNY_TEST_SETTINGS;
		harness = await createApiTestHarness();
		getConfig().presignedAttachmentUploadsEnabled = true;
	});

	beforeEach(() => {
		fakeBunnyStream.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		getConfig().presignedAttachmentUploadsEnabled = presignedDefault;
		getConfig().bunnyStream = streamDefault;
		await harness?.shutdown();
	});

	// A published Bunny video post as the scan writes it (media evidence.ts, video/mp2t), with its HLS files at Bunny.
	async function publishVideoPost(account: TestAccount): Promise<{post: FeedPostRow; media: FeedMedia; guid: string}> {
		const author = (await getUserRepository().findUnique(createUserID(BigInt(account.userId))))!;
		const guid = fakeBunnyStream.putVideo();
		await fakeBunnyStream.finishVideo(guid, {length: 8, width: 1280, height: 720});
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
			duration: 8,
			stream_video_id: guid,
			stream_mp4_file: 'play_720p.mp4',
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

	// The bytes the evidence copy joins: the 720p segments in playlist order.
	function hlsBytes(guid: string): Buffer {
		return Buffer.concat([0, 1].map((segment) => fakeBunnyStream.getFile(guid, `720p/video${segment}.ts`)!));
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

	async function moderator(acls: Array<string>): Promise<TestAccount> {
		return setUserACLs(harness, await createTestAccount(harness), [AdminACLs.AUTHENTICATE, ...acls]);
	}

	const report = (account: TestAccount, path: string, body: object) =>
		createBuilder<ReportResponse>(harness, account.token).post(`/reports/${path}`).body(body);
	const adminReport = (admin: TestAccount, reportId: string) =>
		createBuilder<AdminReport>(harness, admin.token).get(`/admin/reports/${reportId}`).execute();
	const comment = (account: TestAccount, postId: string, content: string) =>
		createBuilder<FeedCommentResponse>(harness, account.token)
			.post(`/feed/posts/${postId}/comments`)
			.body({content})
			.execute();

	it('files post and comment reports as FEED_POST and FEED_COMMENT with the item in message_context', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const post = await createPost(harness, alice, {
			content: 'şikayetlik',
			attachments: [await uploadImage(alice)],
		}).execute();
		const media = post.attachments[0]!;
		const reply = await comment(carol, post.id, 'kaba yorum');
		const admin = await moderator([AdminACLs.REPORT_VIEW]);
		const aliceChannel = userIdToChannelId(createUserID(BigInt(alice.userId))).toString();

		const postReport = await report(bob, 'feed-post', {post_id: post.id, category: 'spam'}).execute();
		expect(postReport.status).toBe('pending');
		await report(bob, 'feed-post', {post_id: post.id, category: 'spam'})
			.expect(HTTP_STATUS.CONFLICT, APIErrorCodes.CONFLICT)
			.execute();
		await report(alice, 'feed-post', {post_id: post.id, category: 'spam'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CANNOT_REPORT_YOURSELF)
			.execute();
		await report(bob, 'feed-post', {post_id: '1', category: 'spam'})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();

		const postDetail = await adminReport(admin, postReport.report_id);
		expect(postDetail).toMatchObject({report_type: 3, reported_user_id: alice.userId, reported_message_id: post.id});
		expect(postDetail.message_context).toEqual([
			expect.objectContaining({
				id: post.id,
				channel_id: aliceChannel,
				author_id: alice.userId,
				content: 'şikayetlik',
				attachments: [expect.objectContaining({id: media.id, filename: 'photo.png', ncmec_status: 'not_submitted'})],
			}),
		]);
		// The image is copied to the reports bucket under the key the NCMEC submission reads (channel, attachment, name).
		const reportKey = `attachments/${aliceChannel}/${media.id}/photo.png`;
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.reports, reportKey)).not.toBeNull();

		const commentReport = await report(bob, 'feed-comment', {
			post_id: post.id,
			comment_id: reply.id,
			category: 'harassment',
		}).execute();
		const commentDetail = await adminReport(admin, commentReport.report_id);
		expect(commentDetail).toMatchObject({
			report_type: 4,
			reported_user_id: carol.userId,
			reported_message_id: reply.id,
		});
		expect(commentDetail.message_context.map((entry) => [entry.id, entry.author_id, entry.content])).toEqual([
			[post.id, alice.userId, 'şikayetlik'],
			[reply.id, carol.userId, 'kaba yorum'],
		]);
		await report(bob, 'feed-comment', {post_id: post.id, comment_id: '1', category: 'spam'})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
	});

	it('lets a FEED_MODERATE admin delete a post: gone from timelines, author told by system DM, audit logged', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		await followDirectly(bob.userId, alice.userId);
		const jobs = captureJobs();
		const post = await createPost(harness, alice, {content: 'kural dışı'}).execute();
		await runFanout(jobs);
		expect((await getHome(harness, bob).execute()).map((entry) => entry.id)).toEqual([post.id]);

		const outsider = await moderator([]);
		await createBuilder(harness, outsider.token)
			.delete(`/admin/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.FORBIDDEN)
			.execute();

		const admin = await moderator([AdminACLs.FEED_MODERATE]);
		await createBuilder(harness, admin.token)
			.delete(`/admin/feed/posts/${post.id}`)
			.header('X-Audit-Log-Reason', 'spam')
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(await getHome(harness, bob).execute()).toEqual([]);
		await createBuilder(harness, bob.token)
			.get(`/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
		await createBuilder(harness, admin.token)
			.delete(`/admin/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
		const dms = jobs.filter((job) => job.task === 'sendSystemDm');
		expect(dms).toEqual([{task: 'sendSystemDm', payload: {content: expect.any(String), user_ids: [alice.userId]}}]);
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		expect(logs.filter((log) => log.action === 'delete_feed_post')).toEqual([
			expect.objectContaining({
				adminUserId: createUserID(BigInt(admin.userId)),
				targetType: 'feed_post',
				targetId: BigInt(post.id),
				auditLogReason: 'spam',
			}),
		]);
	});

	it('sends the images of a moderator-deleted post to the priority CDN purge', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {attachments: [await uploadImage(alice)]}).execute();
		const media = post.attachments[0]!;
		const cdnKey = `attachments/${userIdToChannelId(createUserID(BigInt(alice.userId)))}/${media.id}/photo.png`;
		const purge = vi.spyOn(getPurgeQueue(), 'addUrls');
		const admin = await moderator([AdminACLs.FEED_MODERATE]);

		await createBuilder(harness, admin.token)
			.delete(`/admin/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, cdnKey)).toBeNull();
		expect(purge).toHaveBeenCalledWith([`${Config.endpoints.media}/${cdnKey}`], {priority: true});
	});

	it('keeps the images of a moderator-deleted post in the reports bucket and names them in the audit log', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {attachments: [await uploadImage(alice)]}).execute();
		const media = post.attachments[0]!;
		const cdnKey = `attachments/${userIdToChannelId(createUserID(BigInt(alice.userId)))}/${media.id}/photo.png`;
		const admin = await moderator([AdminACLs.FEED_MODERATE]);

		await createBuilder(harness, admin.token)
			.delete(`/admin/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, cdnKey)).toBeNull();
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.reports, cdnKey)).not.toBeNull();
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		const log = logs.find((entry) => entry.action === 'delete_feed_post' && entry.targetId === BigInt(post.id));
		expect(log?.metadata.get('evidence_keys')).toBe(cdnKey);
	});

	it('removes a feed post when the NCMEC report of its image is finalized, with the priority CDN purge', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {attachments: [await uploadImage(alice)]}).execute();
		const media = post.attachments[0]!;
		const reported = await report(bob, 'feed-post', {post_id: post.id, category: 'spam'}).execute();
		const aliceChannel = userIdToChannelId(createUserID(BigInt(alice.userId)));
		const cdnKey = `attachments/${aliceChannel}/${media.id}/photo.png`;
		const now = new Date();
		const submission: NcmecAttachmentSubmissionRow = {
			attachment_id: BigInt(media.id),
			user_id: BigInt(alice.userId),
			channel_id: BigInt(aliceChannel),
			message_id: BigInt(post.id),
			filename: 'photo.png',
			source_report_id: BigInt(reported.report_id),
			status: 'submitted',
			ncmec_report_id: '1',
			ncmec_file_id: 'file-1',
			submitted_at: now,
			submitted_by_admin_id: 1n,
			reporter_full_name: 'Reporter',
			failure_reason: null,
			archive_completed_at: null,
			content_deleted_at: null,
			created_at: now,
			updated_at: now,
		};
		// Archived before any ban, so finalizing goes straight to removing the content.
		const workflow: NcmecUserWorkflowRow = {
			user_id: BigInt(alice.userId),
			deleted_at: null,
			deleted_by_admin_id: null,
			deletion_private_reason: null,
			deletion_ncmec_report_id: null,
			archive_id: 5n,
			archive_requested_at: now,
			archive_requested_by_admin_id: 1n,
			archive_audit_log_reason: null,
			archive_completed_at: now,
			deletion_job_queued_at: now,
			previous_report_ids: null,
			created_at: now,
			updated_at: now,
		};
		const written: Array<NcmecAttachmentSubmissionRow> = [];
		const purge = vi.spyOn(getPurgeQueue(), 'addUrls');
		const service = new NcmecSubmissionService({
			ncmecRepository: {
				getAttachmentSubmission: async () => submission,
				getUserWorkflow: async () => workflow,
				upsertAttachmentSubmission: async (row: NcmecAttachmentSubmissionRow) => {
					written.push(row);
				},
				upsertUserWorkflow: async () => {},
			},
			adminArchiveService: {getArchive: async () => ({completed_at: now.toISOString()})},
			channelRepository: getChannelRepository(),
			reportRepository: getReportRepository(),
			feedPostService: getFeedPostService(),
			purgeQueue: getPurgeQueue(),
			updatePropagator: {},
		} as unknown as ConstructorParameters<typeof NcmecSubmissionService>[0]);

		await service.finalizeAttachmentReport(createAttachmentID(BigInt(media.id)));

		await createBuilder(harness, bob.token)
			.get(`/feed/posts/${post.id}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.cdn, cdnKey)).toBeNull();
		expect(purge).toHaveBeenCalledWith([`${Config.endpoints.media}/${cdnKey}`], {priority: true});
		expect(written.at(-1)?.content_deleted_at).toBeInstanceOf(Date);
	});

	it('lets a FEED_MODERATE admin put a report-hidden public post back on Keşfet, audit logged', async () => {
		const alice = await createTestAccount(harness);
		const post = await createPost(harness, alice, {content: 'yanlış raporlandı', public: true}).execute();
		await getFeedDiscoverRepository().hidePost(BigInt(post.id));
		const path = `/admin/feed/posts/${post.id}/discover-hide`;

		const outsider = await moderator([]);
		await createBuilder(harness, outsider.token).delete(path).expect(HTTP_STATUS.FORBIDDEN).execute();

		const admin = await moderator([AdminACLs.FEED_MODERATE]);
		await createBuilder(harness, admin.token)
			.delete(path)
			.header('X-Audit-Log-Reason', 'false report')
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(await getKVClient().get(`feed:discover:hidden:${post.id}`)).toBeNull();
		expect(await getKVClient().get(`feed:discover:cleared:${post.id}`)).toBe('1');
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		expect(logs.filter((log) => log.action === 'restore_feed_post_discover')).toEqual([
			expect.objectContaining({
				adminUserId: createUserID(BigInt(admin.userId)),
				targetType: 'feed_post',
				targetId: BigInt(post.id),
				auditLogReason: 'false report',
			}),
		]);
		await createBuilder(harness, admin.token)
			.delete('/admin/feed/posts/1/discover-hide')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
	});

	it('lets a FEED_MODERATE admin delete a comment and tells its author', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'yorumlar'}).execute();
		const reply = await comment(bob, post.id, 'silinecek');
		const jobs = captureJobs();
		const admin = await moderator([AdminACLs.FEED_MODERATE]);

		await createBuilder(harness, admin.token)
			.delete(`/admin/feed/posts/${post.id}/comments/${reply.id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(
			await createBuilder<FeedCommentListResponse>(harness, alice.token)
				.get(`/feed/posts/${post.id}/comments`)
				.execute(),
		).toEqual([]);
		expect(jobs.filter((job) => job.task === 'sendSystemDm')).toEqual([
			{task: 'sendSystemDm', payload: {content: expect.any(String), user_ids: [bob.userId]}},
		]);
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		expect(logs.filter((log) => log.action === 'delete_feed_comment')).toEqual([
			expect.objectContaining({targetType: 'feed_comment', targetId: BigInt(reply.id)}),
		]);
		await createBuilder(harness, admin.token)
			.delete(`/admin/feed/posts/${post.id}/comments/${reply.id}`)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
	});

	it('a moderator removes a reply, logs it and DMs its author', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const post = await createPost(harness, alice, {content: 'yanıtlı'}).execute();
		const parent = await comment(alice, post.id, 'üst yorum');
		const reply = await createBuilder<FeedCommentResponse>(harness, bob.token)
			.post(`/feed/posts/${post.id}/comments/${parent.id}/replies`)
			.body({content: 'silinecek yanıt'})
			.execute();
		const path = `/admin/feed/posts/${post.id}/comments/${parent.id}/replies/${reply.id}`;
		const jobs = captureJobs();

		const outsider = await moderator([]);
		await createBuilder(harness, outsider.token).delete(path).expect(HTTP_STATUS.FORBIDDEN).execute();

		const admin = await moderator([AdminACLs.FEED_MODERATE]);
		await createBuilder(harness, admin.token)
			.delete(path)
			.header('X-Audit-Log-Reason', 'harassment')
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(
			await createBuilder<FeedCommentListResponse>(harness, alice.token)
				.get(`/feed/posts/${post.id}/comments/${parent.id}/replies`)
				.execute(),
		).toEqual([]);
		expect(
			await createBuilder<FeedCommentListResponse>(harness, alice.token)
				.get(`/feed/posts/${post.id}/comments`)
				.execute(),
		).toEqual([expect.objectContaining({id: parent.id, reply_count: 0})]);
		expect(jobs.filter((job) => job.task === 'sendSystemDm')).toEqual([
			{task: 'sendSystemDm', payload: {content: expect.any(String), user_ids: [bob.userId]}},
		]);
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		const entries = logs.filter((log) => log.action === 'delete_feed_comment_reply');
		expect(entries).toEqual([
			expect.objectContaining({
				adminUserId: createUserID(BigInt(admin.userId)),
				targetType: 'feed_comment',
				targetId: BigInt(reply.id),
				auditLogReason: 'harassment',
			}),
		]);
		expect(Object.fromEntries(entries[0]!.metadata)).toEqual({
			post_id: post.id,
			parent_id: parent.id,
			author_id: bob.userId,
		});
		await createBuilder(harness, admin.token)
			.delete(path)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
	});

	it('a moderator removal of a video post queues the Bunny delete with the evidence key and logs it', async () => {
		const alice = await createTestAccount(harness);
		const {post, media, guid} = await publishVideoPost(alice);
		const key = feedStreamEvidenceKey(post.author_id, media);
		const jobs = captureJobs();
		const admin = await moderator([AdminACLs.FEED_MODERATE]);
		const marks = vi.spyOn(getFeedVideoRepository(), 'markReported');

		await createBuilder(harness, admin.token)
			.delete(`/admin/feed/posts/${post.post_id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();

		expect(jobs.filter((job) => job.task === 'deleteFeedVideo')).toEqual([
			{task: 'deleteFeedVideo', payload: {guid, priority: true, evidence: key}},
		]);
		// removePost is the one place that records a removal's evidence key.
		expect(marks.mock.calls).toEqual([[guid, key]]);
		const logs = await getAdminRepository().listAllAuditLogsPaginated(1000);
		const log = logs.find((entry) => entry.action === 'delete_feed_post' && entry.targetId === post.post_id);
		expect(log?.metadata.get('evidence_keys')).toBe(key);
	});

	// the account deletion's plain delete shares the job key, so JetStream may drop the moderator's; the evidence
	// key recorded before the removal makes the plain job copy the evidence first.
	it('keeps the evidence of a moderator-removed video when only a plain delete job runs', async () => {
		const alice = await createTestAccount(harness);
		const {post, media, guid} = await publishVideoPost(alice);
		const key = feedStreamEvidenceKey(post.author_id, media);
		const expected = hlsBytes(guid);
		const jobs = captureJobs();
		const admin = await moderator([AdminACLs.FEED_MODERATE]);

		await createBuilder(harness, admin.token)
			.delete(`/admin/feed/posts/${post.post_id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		jobs.splice(0, jobs.length, {task: 'deleteFeedVideo', payload: {guid}});

		expect(await runQueued(jobs, 'deleteFeedVideo', deleteFeedVideo)).toBe(1);
		expect(Buffer.from(await harness.storageService.readObject(Config.s3.buckets.reports, key)).equals(expected)).toBe(
			true,
		);
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
	});

	// every priority removal records the key before its job, the NCMEC and link blocklist ones included.
	it('keeps the evidence of a video post an NCMEC removal takes when only a plain delete job runs', async () => {
		const alice = await createTestAccount(harness);
		const {post, media, guid} = await publishVideoPost(alice);
		const key = feedStreamEvidenceKey(post.author_id, media);
		const expected = hlsBytes(guid);
		const jobs = captureJobs();

		await getFeedPostService().removePostById(post.post_id, {priority: true});
		jobs.splice(0, jobs.length, {task: 'deleteFeedVideo', payload: {guid}});

		expect(await runQueued(jobs, 'deleteFeedVideo', deleteFeedVideo)).toBe(1);
		expect(Buffer.from(await harness.storageService.readObject(Config.s3.buckets.reports, key)).equals(expected)).toBe(
			true,
		);
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
	});

	// ORTA-1: a plain delete already queued under the job key would drop the evidence-carrying job as a duplicate, so a
	// removal whose evidence key cannot be recorded fails whole: the post stays, no delete is queued, the caller retries.
	it('fails a video post removal whose evidence key cannot be recorded and keeps the evidence on its retry', async () => {
		const alice = await createTestAccount(harness);
		const {post, media, guid} = await publishVideoPost(alice);
		const key = feedStreamEvidenceKey(post.author_id, media);
		const expected = hlsBytes(guid);
		const jobs = captureJobs();
		const marks = vi.spyOn(getFeedVideoRepository(), 'markReported').mockRejectedValue(new Error('kv down'));
		const error = vi.spyOn(Logger.child({}) as unknown as NoopLogger, 'error');

		await expect(getFeedPostService().removePostById(post.post_id, {priority: true})).rejects.toThrow('kv down');
		expect(await getFeedPostService().deps.repository.getPost(post.post_id)).not.toBeNull();
		expect(jobs.filter((job) => job.task === 'deleteFeedVideo')).toEqual([]);
		expect(error).toHaveBeenCalledWith(
			expect.objectContaining({guid}),
			'Recording a feed video evidence key failed; the removal stops for a retry',
		);

		// The retry records the key, so even the plain delete holding the job key copies the evidence first.
		marks.mockRestore();
		await getFeedPostService().removePostById(post.post_id, {priority: true});
		jobs.splice(0, jobs.length, {task: 'deleteFeedVideo', payload: {guid}});
		expect(await runQueued(jobs, 'deleteFeedVideo', deleteFeedVideo)).toBe(1);
		expect(Buffer.from(await harness.storageService.readObject(Config.s3.buckets.reports, key)).equals(expected)).toBe(
			true,
		);
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
	});

	// a disabled (banned) account gets no feed DM, as a deleted one does not.
	it('sends feed DMs to an active author only', async () => {
		const alice = await createTestAccount(harness);
		const aliceId = createUserID(BigInt(alice.userId));
		const worker = {addJob: vi.fn(async () => 0n)};
		await sendFeedAuthorDm({users: getUserRepository(), worker}, aliceId, 'feed.video_failed');
		expect(worker.addJob).toHaveBeenCalledTimes(1);

		const user = (await getUserRepository().findUnique(aliceId))!;
		await getUserRepository().patchUpsert(aliceId, {flags: user.flags | UserFlags.DISABLED}, user.toRow());
		await sendFeedAuthorDm({users: getUserRepository(), worker}, aliceId, 'feed.post_removed_by_moderator');
		expect(worker.addJob).toHaveBeenCalledTimes(1);
	});

	it('reporting a video post queues the evidence copy and lists evidence.ts (video/mp2t) under that key', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const {post, media, guid} = await publishVideoPost(alice);
		const key = feedStreamEvidenceKey(post.author_id, media);
		const jobs = captureJobs();

		const reported = await report(bob, 'feed-post', {post_id: post.post_id.toString(), category: 'spam'}).execute();

		expect(jobs.filter((job) => job.task === 'keepFeedVideoEvidence')).toEqual([
			{task: 'keepFeedVideoEvidence', payload: {guid, evidenceKey: key}},
		]);
		expect(await getFeedVideoRepository().getReported(guid)).toBe(key);
		// A filed report keeps the key 30 days.
		expect(await getKVClient().ttl(`feed:video:reported:${guid}`)).toBeGreaterThan(29 * 86_400);
		const stored = await getReportRepository().getReport(createReportID(BigInt(reported.report_id)));
		const [attachment] = stored!.messageContext!.at(-1)!.attachments;
		expect(attachment).toMatchObject({filename: 'evidence.ts', content_type: 'video/mp2t'});
		const channelId = userIdToChannelId(post.author_id);
		expect(`attachments/${channelId}/${attachment!.attachment_id}/${attachment!.filename}`).toBe(key);
		// A video has no CDN object to copy; its evidence comes from the video lane only.
		const copies = harness.storageService.copyObjectSpy.mock.calls as Array<[{destinationKey: string}]>;
		expect(copies.filter(([params]) => params.destinationKey === key)).toEqual([]);
	});

	it('a refused report of a video post queues no evidence copy', async () => {
		const alice = await createTestAccount(harness);
		const {post, media, guid} = await publishVideoPost(alice);
		const jobs = captureJobs();

		await report(alice, 'feed-post', {post_id: post.post_id.toString(), category: 'spam'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CANNOT_REPORT_YOURSELF)
			.execute();

		expect(jobs.filter((job) => job.task === 'keepFeedVideoEvidence')).toEqual([]);
		// Only the key is kept (no copy), so a delete racing the report still keeps the evidence first; for 5 minutes
		// only, so a later delete of the refused report's video copies nothing.
		expect(await getFeedVideoRepository().getReported(guid)).toBe(feedStreamEvidenceKey(post.author_id, media));
		const ttl = await getKVClient().ttl(`feed:video:reported:${guid}`);
		expect(ttl).toBeGreaterThan(0);
		expect(ttl).toBeLessThanOrEqual(300);
	});

	it('a refused report does not shorten the evidence key of a filed one', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const {post, guid} = await publishVideoPost(alice);
		captureJobs();

		await report(bob, 'feed-post', {post_id: post.post_id.toString(), category: 'spam'}).execute();
		await report(alice, 'feed-post', {post_id: post.post_id.toString(), category: 'spam'})
			.expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CANNOT_REPORT_YOURSELF)
			.execute();

		expect(await getKVClient().ttl(`feed:video:reported:${guid}`)).toBeGreaterThan(29 * 86_400);
	});

	it('reporting a comment on a video post keeps the video evidence as a post report does', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const {post, media, guid} = await publishVideoPost(alice);
		const rude = await comment(alice, post.post_id.toString(), 'kaba yorum');
		const jobs = captureJobs();

		await report(bob, 'feed-comment', {
			post_id: post.post_id.toString(),
			comment_id: rude.id,
			category: 'harassment',
		}).execute();

		const key = feedStreamEvidenceKey(post.author_id, media);
		expect(jobs.filter((job) => job.task === 'keepFeedVideoEvidence')).toEqual([
			{task: 'keepFeedVideoEvidence', payload: {guid, evidenceKey: key}},
		]);
		expect(await getFeedVideoRepository().getReported(guid)).toBe(key);
	});

	it('a video report attachment carries no stream fields', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const {post} = await publishVideoPost(alice);
		captureJobs();

		const reported = await report(bob, 'feed-post', {post_id: post.post_id.toString(), category: 'spam'}).execute();

		const stored = await getReportRepository().getReport(createReportID(BigInt(reported.report_id)));
		const [attachment] = stored!.messageContext!.at(-1)!.attachments;
		expect(attachment).toBeDefined();
		expect(Object.keys(attachment!)).not.toContain('stream_video_id');
		expect(Object.keys(attachment!)).not.toContain('stream_mp4_file');
	});

	it('a reported video’s evidence can be submitted to NCMEC', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const {post, media, guid} = await publishVideoPost(alice);
		const expected = hlsBytes(guid);
		const jobs = captureJobs();
		const reported = await report(bob, 'feed-post', {
			post_id: post.post_id.toString(),
			category: 'child_safety',
		}).execute();
		expect(await runQueued(jobs, 'keepFeedVideoEvidence', keepFeedVideoEvidence)).toBe(1);
		const key = feedStreamEvidenceKey(post.author_id, media);
		expect(Buffer.from(await harness.storageService.readObject(Config.s3.buckets.reports, key)).equals(expected)).toBe(
			true,
		);
		const admin = await setUserACLs(harness, await createTestAccount(harness), [AdminACLs.WILDCARD]);

		const response = await harness.requestJson({
			path: '/admin/messages/ncmec-reports',
			method: 'POST',
			body: {
				channel_id: userIdToChannelId(post.author_id).toString(),
				message_id: post.post_id.toString(),
				attachment_id: media.attachment_id.toString(),
				filename: 'evidence.ts',
				source_report_id: reported.report_id,
				reporter_full_name: 'Feed Reporter',
				confirmed_viewed: true,
			},
			headers: {Authorization: admin.token, 'X-Audit-Log-Reason': 'feed video NCMEC'},
		});

		expect(response.status).toBe(200);
		const [ncmecReport] = fakeNcmecServer.getReports();
		expect(ncmecReport?.files).toEqual([
			expect.objectContaining({
				filename: 'evidence.ts',
				size: expected.length,
				md5: createHash('md5').update(expected).digest('hex'),
			}),
		]);
	});

	it('reporting a reply with parent_comment_id files it; without the parent it is unknown', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 2);
		const [bob, carol] = members as [TestAccount, TestAccount];
		const post = await createPost(harness, alice, {content: 'yanıtlı gönderi'}).execute();
		const parent = await comment(alice, post.id, 'üst yorum');
		const reply = await createBuilder<FeedCommentResponse>(harness, carol.token)
			.post(`/feed/posts/${post.id}/comments/${parent.id}/replies`)
			.body({content: 'kaba yanıt'})
			.execute();
		const admin = await moderator([AdminACLs.REPORT_VIEW]);

		await report(bob, 'feed-comment', {post_id: post.id, comment_id: reply.id, category: 'harassment'})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		await report(bob, 'feed-comment', {
			post_id: post.id,
			comment_id: reply.id,
			parent_comment_id: reply.id,
			category: 'harassment',
		})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		const filed = await report(bob, 'feed-comment', {
			post_id: post.id,
			comment_id: reply.id,
			parent_comment_id: parent.id,
			category: 'harassment',
		}).execute();

		const detail = await adminReport(admin, filed.report_id);
		expect(detail).toMatchObject({report_type: 4, reported_user_id: carol.userId, reported_message_id: reply.id});
		// The parent comment sits between the post and the reply, so a moderator has the IDs the reply delete route takes.
		expect(detail.message_context.map((entry) => [entry.id, entry.author_id, entry.content])).toEqual([
			[post.id, alice.userId, 'yanıtlı gönderi'],
			[parent.id, alice.userId, 'üst yorum'],
			[reply.id, carol.userId, 'kaba yanıt'],
		]);
	});

	it('after the author deletes a reported video the delete job still copies the evidence first', async () => {
		const {owner: alice, members} = await setupTestGuildWithMembers(harness, 1);
		const bob = members[0]!;
		const {post, media, guid} = await publishVideoPost(alice);
		const key = feedStreamEvidenceKey(post.author_id, media);
		const expected = hlsBytes(guid);
		const jobs = captureJobs();
		await report(bob, 'feed-post', {post_id: post.post_id.toString(), category: 'spam'}).execute();
		// The report's own copy job has not run yet, and the first segment read fails.
		jobs.splice(0, jobs.length);
		fakeBunnyStream.failWhen((call) => call.service === 'storage' && call.path.endsWith('.ts'), 500, 1);

		await createBuilder(harness, alice.token)
			.delete(`/feed/posts/${post.post_id}`)
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
		expect(jobs.filter((job) => job.task === 'deleteFeedVideo')).toEqual([{task: 'deleteFeedVideo', payload: {guid}}]);

		// A failed copy keeps the video at Bunny and queues the delete again.
		expect(await runQueued(jobs, 'deleteFeedVideo', deleteFeedVideo)).toBe(1);
		expect(fakeBunnyStream.getVideo(guid)).not.toBeNull();
		expect(fakeBunnyStream.getCalls().filter((call) => call.method === 'DELETE')).toEqual([]);
		expect(await harness.storageService.getObjectMetadata(Config.s3.buckets.reports, key)).toBeNull();

		expect(await runQueued(jobs, 'deleteFeedVideo', deleteFeedVideo)).toBe(1);
		expect(Buffer.from(await harness.storageService.readObject(Config.s3.buckets.reports, key)).equals(expected)).toBe(
			true,
		);
		const calls = fakeBunnyStream.getCalls();
		const lastSegment = calls.findLastIndex((call) => call.path.endsWith('.ts'));
		expect(calls.findIndex((call) => call.method === 'DELETE')).toBeGreaterThan(lastSegment);
		expect(fakeBunnyStream.getVideo(guid)).toBeNull();
	});
});
