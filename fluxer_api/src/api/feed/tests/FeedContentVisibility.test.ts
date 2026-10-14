// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {
	captureJobs,
	createPost,
	followDirectly,
	getHome,
	overrideLimits,
	runFanout,
	setProfileLevel,
} from '@app/api/feed/tests/FeedTestUtils';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {
	getFeedRepository,
	getFeedTimelineService,
	getUserCacheService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {
	FeedCommentListResponse,
	FeedCommentResponse,
	FeedPostListResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

describe('feed authored content cutoff', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});
	async function mark(account: TestAccount, since: Date | null): Promise<void> {
		const userId = createUserID(BigInt(account.userId));
		const user = (await getUserRepository().findUnique(userId))!;
		await getUserRepository().patchUpsert(userId, {content_hidden_since: since}, user.toRow());
		await getUserCacheService().invalidateUserCache(userId);
	}
	const comments = (account: TestAccount, post: string, query = '') =>
		createBuilder<FeedCommentListResponse>(harness, account.token).get(`/feed/posts/${post}/comments${query}`);
	const replyList = (account: TestAccount, post: string, parent: string) =>
		createBuilder<FeedCommentListResponse>(harness, account.token).get(
			`/feed/posts/${post}/comments/${parent}/replies`,
		);
	const comment = (account: TestAccount, post: string, content: string) =>
		createBuilder<FeedCommentResponse>(harness, account.token).post(`/feed/posts/${post}/comments`).body({content});

	it('hides at-cutoff posts from home, author list and direct readers including owner, then restores them', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 1);
		const reader = members[0]!;
		await followDirectly(reader.userId, owner.userId);
		const jobs = captureJobs();
		const old = await createPost(harness, owner, {content: 'before cutoff'}).execute();
		const recent = await createPost(harness, owner, {content: 'at cutoff'}).execute();
		await runFanout(jobs);
		const since = snowflakeToDate(BigInt(recent.id));
		expect(snowflakeToDate(BigInt(old.id)).getTime()).toBeLessThan(since.getTime());
		await mark(owner, since);
		expect((await getHome(harness, reader).execute()).map((post) => post.id)).toEqual([old.id]);
		const authorList = await createBuilder<FeedPostListResponse>(harness, reader.token)
			.get(`/users/${owner.userId}/posts`)
			.execute();
		expect(authorList.map((post) => post.id)).toEqual([old.id]);
		for (const viewer of [owner, reader]) {
			await createBuilder(harness, viewer.token)
				.get(`/feed/posts/${recent.id}`)
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
				.execute();
		}
		expect(await getFeedRepository().getPost(BigInt(recent.id))).not.toBeNull();
		await mark(owner, null);
		expect((await getHome(harness, reader).execute()).map((post) => post.id)).toEqual([recent.id, old.id]);
		const restored = await createBuilder(harness, reader.token).get(`/feed/posts/${recent.id}`).execute();
		expect(JSON.stringify(restored)).not.toContain('content_hidden_since');
	});

	it('filters already built Discover bases on every output without destroying them', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 2);
		const [reader, other] = members as [TestAccount, TestAccount];
		const hidden = await createPost(harness, owner, {content: 'cached author'}).execute();
		const visible = await createPost(harness, other, {content: 'other author'}).execute();
		const rows = [...(await getFeedRepository().getPosts([BigInt(hidden.id), BigInt(visible.id)])).values()];
		const hiddenRow = rows.find((row) => row.post_id === BigInt(hidden.id))!;
		hiddenRow.media = [
			{
				attachment_id: 1n,
				filename: 'hidden.png',
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
		];
		const timeline = getFeedTimelineService();
		const bases = await timeline.buildBaseResponses(rows, createRequestCache());
		await mark(owner, snowflakeToDate(BigInt(hidden.id)));
		const result = await timeline.applyViewerState(createUserID(BigInt(reader.userId)), bases);
		expect(result.map((post) => post.id)).toEqual([visible.id]);
		expect(JSON.stringify(result)).not.toContain('hidden.png');
		expect(bases).toHaveLength(2);
		await mark(owner, null);
		expect(
			(await timeline.applyViewerState(createUserID(BigInt(reader.userId)), bases)).map((post) => post.id),
		).toEqual(bases.map((post) => post.id));
	});

	it('filters comments and replies by their own author cutoff and restores a hidden parent', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 2);
		const [writer, reader] = members as [TestAccount, TestAccount];
		overrideLimits({feed_max_comments_per_post: 100});
		const post = await createPost(harness, owner, {content: 'visible post'}).execute();
		const older = await comment(writer, post.id, 'older comment').execute();
		const parent = await comment(writer, post.id, 'recent parent').execute();
		const visible = await comment(reader, post.id, 'different author').execute();
		const reply = await createBuilder<FeedCommentResponse>(harness, writer.token)
			.post(`/feed/posts/${post.id}/comments/${older.id}/replies`)
			.body({content: 'recent reply'})
			.execute();
		await mark(writer, snowflakeToDate(BigInt(parent.id)));
		expect((await comments(reader, post.id).execute()).map((entry) => entry.id)).toEqual([visible.id, older.id]);
		expect(await replyList(reader, post.id, older.id).execute()).toEqual([]);
		await replyList(reader, post.id, parent.id)
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
		await mark(writer, null);
		expect((await comments(reader, post.id).execute()).map((entry) => entry.id)).toEqual([
			visible.id,
			parent.id,
			older.id,
		]);
		expect((await replyList(reader, post.id, older.id).execute()).map((entry) => entry.id)).toEqual([reply.id]);
	});

	it('advances past a fully hidden comment page to a visible older entry', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 1);
		const writer = members[0]!;
		const post = await createPost(harness, owner, {content: 'comment paging'}).execute();
		const visible = await comment(owner, post.id, 'visible older').execute();
		const hidden = await comment(writer, post.id, 'hidden newer').execute();
		await mark(writer, snowflakeToDate(BigInt(hidden.id)));
		expect((await comments(owner, post.id, '?limit=1').execute()).map((entry) => entry.id)).toEqual([visible.id]);
	});

	it('returns no new post or comment text while its author cutoff covers the write', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 1);
		const writer = members[0]!;
		const post = await createPost(harness, owner, {content: 'visible parent'}).execute();
		await mark(writer, new Date(0));
		await createPost(harness, writer, {content: 'hidden new post'})
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
			.execute();
		await comment(writer, post.id, 'hidden new comment')
			.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_COMMENT)
			.execute();
	});

	it.each(['full', 'public'] as const)(
		'keeps the raw author-list cursor when a %s page is entirely hidden',
		async (access) => {
			const {owner, members} = await setupTestGuildWithMembers(harness, 1);
			const reader = access === 'full' ? members[0]! : await createTestAccount(harness);
			await setProfileLevel(owner, 100);
			const older = await createPost(harness, owner, {content: 'older visible post'}).execute();
			const hidden = await createPost(harness, owner, {content: 'hidden first page'}).execute();
			if (access === 'public') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 3_600_000);
			await mark(owner, snowflakeToDate(BigInt(hidden.id)));
			const first = await createBuilder<FeedPostListResponse>(harness, reader.token)
				.get(`/users/${owner.userId}/posts?limit=1`)
				.executeWithResponse();
			expect(first.json).toEqual([]);
			expect(first.response.headers.get('X-Next-Before')).toBe(hidden.id);
			const next = await createBuilder<FeedPostListResponse>(harness, reader.token)
				.get(`/users/${owner.userId}/posts?limit=1&before=${first.response.headers.get('X-Next-Before')}`)
				.execute();
			expect(next.map((post) => post.id)).toEqual([older.id]);
		},
	);

	it('preserves comment continuation after three fully hidden storage pages', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 3);
		const post = await createPost(harness, owner, {content: 'bounded comment continuation'}).execute();
		const older = await comment(owner, post.id, 'visible oldest').execute();
		const hidden: Array<FeedCommentResponse> = [];
		for (const writer of members) {
			hidden.push(await comment(writer, post.id, 'hidden page').execute());
			await mark(writer, new Date(0));
		}
		const first = await comments(owner, post.id, '?limit=1').executeWithResponse();
		expect(first.json).toEqual([]);
		expect(first.response.headers.get('X-Next-Before')).toBe(hidden[0]!.id);
		const next = await comments(
			owner,
			post.id,
			`?limit=1&before=${first.response.headers.get('X-Next-Before')}`,
		).execute();
		expect(next.map((entry) => entry.id)).toEqual([older.id]);
	});

	it('preserves reply continuation after three fully hidden storage pages', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 3);
		const post = await createPost(harness, owner, {content: 'bounded reply continuation'}).execute();
		const parent = await comment(owner, post.id, 'visible parent').execute();
		const createReply = (writer: TestAccount) =>
			createBuilder<FeedCommentResponse>(harness, writer.token)
				.post(`/feed/posts/${post.id}/comments/${parent.id}/replies`)
				.body({content: 'reply'})
				.execute();
		const older = await createReply(owner);
		const hidden: Array<FeedCommentResponse> = [];
		for (const writer of members) {
			hidden.push(await createReply(writer));
			await mark(writer, new Date(0));
		}
		const path = `/feed/posts/${post.id}/comments/${parent.id}/replies?limit=1`;
		const first = await createBuilder<FeedCommentListResponse>(harness, owner.token).get(path).executeWithResponse();
		expect(first.json).toEqual([]);
		expect(first.response.headers.get('X-Next-Before')).toBe(hidden[0]!.id);
		const next = await createBuilder<FeedCommentListResponse>(harness, owner.token)
			.get(`${path}&before=${first.response.headers.get('X-Next-Before')}`)
			.execute();
		expect(next.map((entry) => entry.id)).toEqual([older.id]);
	});
});
