// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {
	blockUser,
	createFriendship,
	setupTestGuildWithMembers,
	updateUserSettings,
} from '@app/api/channel/tests/ChannelTestUtils';
import {createPost} from '@app/api/feed/tests/FeedTestUtils';
import {FollowRepository} from '@app/api/follow/FollowRepository';
import {getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {UserChannelRepository} from '@app/api/user/repositories/UserChannelRepository';
import {UserRelationshipRepository} from '@app/api/user/repositories/UserRelationshipRepository';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {RelationshipTypes, UserFlags} from '@fluxer/constants/src/UserConstants';
import type {FeedCommentResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

type Route = {name: string; method: 'get' | 'put' | 'delete' | 'post'; path: string; body?: object; ok: number};

const HOUR = 3_600_000;
const TOO_MANY_REQUESTS = 429;

// Every route that reads or acts on one post; the likers list stays on the profile rule even for public posts.
// The comment report needs a comment the author wrote (postWithComment); the vote route's own matrix is in FeedPollRoutes.test.ts.
function postRoutes(postId: string, commentId = '0'): Array<Route> {
	return [
		{name: 'get post', method: 'get', path: `/feed/posts/${postId}`, ok: HTTP_STATUS.OK},
		{name: 'like', method: 'put', path: `/feed/posts/${postId}/like`, ok: HTTP_STATUS.NO_CONTENT},
		{name: 'unlike', method: 'delete', path: `/feed/posts/${postId}/like`, ok: HTTP_STATUS.NO_CONTENT},
		{name: 'list comments', method: 'get', path: `/feed/posts/${postId}/comments`, ok: HTTP_STATUS.OK},
		{
			name: 'comment',
			method: 'post',
			path: `/feed/posts/${postId}/comments`,
			body: {content: 'selam'},
			ok: HTTP_STATUS.OK,
		},
		{
			name: 'report',
			method: 'post',
			path: '/reports/feed-post',
			body: {post_id: postId, category: 'spam'},
			ok: HTTP_STATUS.OK,
		},
		{
			name: 'report comment',
			method: 'post',
			path: '/reports/feed-comment',
			body: {post_id: postId, comment_id: commentId, category: 'spam'},
			ok: HTTP_STATUS.OK,
		},
	];
}

describe('public feed posts and the profile rule (S-2)', () => {
	let harness: ApiTestHarness;
	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	afterEach(() => vi.restoreAllMocks());
	afterAll(async () => {
		await harness?.shutdown();
	});

	function call(viewer: TestAccount, route: Route) {
		const builder = createBuilder(harness, viewer.token)[route.method](route.path);
		return route.body ? builder.body(route.body) : builder;
	}

	// the server sets the public bit from the author's level, so each test sets the level it means.
	const setLevel = (account: TestAccount, level: number) =>
		updateUserSettings(harness, account.token, {profile_privacy: level});

	async function postWithComment(author: TestAccount, body: {content: string; public?: boolean}) {
		await setLevel(author, body.public ? 100 : 0);
		const post = await createPost(harness, author, body).execute();
		const comment = await createBuilder<FeedCommentResponse>(harness, author.token)
			.post(`/feed/posts/${post.id}/comments`)
			.body({content: 'yazarın yorumu'})
			.execute();
		return {post, commentId: comment.id};
	}

	it('stores a post as public only while its author is public, whatever the request says (Ş4)', async () => {
		const author = await createTestAccount(harness);
		await setLevel(author, 0);
		expect((await createPost(harness, author, {content: 'gizli', public: true}).execute()).public).toBe(false);
		await setLevel(author, 100);
		expect((await createPost(harness, author, {content: 'açık'}).execute()).public).toBe(true);
	});

	it('refuses a stranger on every route of a non-public post', async () => {
		const [author, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
		const {post, commentId} = await postWithComment(author, {content: 'gizli'});
		for (const route of postRoutes(post.id, commentId)) {
			await call(stranger, route).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		}
	});

	it('lets an established stranger read, like, comment and report a public post but not list its likers', async () => {
		const [author, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
		const {post, commentId} = await postWithComment(author, {content: 'açık', public: true});
		// A day later the stranger's account is old enough to comment (the post is still inside its 72 hours).
		vi.useFakeTimers({now: Date.now() + 25 * HOUR, toFake: ['Date']});
		try {
			for (const route of postRoutes(post.id, commentId)) await call(stranger, route).expect(route.ok).execute();
		} finally {
			vi.useRealTimers();
		}
		await createBuilder(harness, stranger.token)
			.get(`/feed/posts/${post.id}/likes`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
		await createBuilder(harness, stranger.token)
			.get(`/users/${author.userId}/posts`)
			.expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS)
			.execute();
	});

	// the public branch needs the author side and a block, never the bond class (friendship, follow, pending
	// requests, the reader's private channels).
	it('reads and likes a public post of a public author without computing the bond', async () => {
		const [author, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
		await setLevel(author, 100);
		const post = await createPost(harness, author, {content: 'açık', public: true}).execute();
		const strangerId = createUserID(BigInt(stranger.userId));
		const channelReads = vi.spyOn(UserChannelRepository.prototype, 'listPrivateChannels');
		const followReads = vi.spyOn(FollowRepository.prototype, 'getFollow');
		const relationshipReads = vi.spyOn(UserRelationshipRepository.prototype, 'getRelationship');

		const [read, like] = postRoutes(post.id);
		await call(stranger, read!).expect(read!.ok).execute();
		await call(stranger, like!).expect(like!.ok).execute();
		expect(channelReads.mock.calls.filter(([userId]) => userId === strangerId)).toEqual([]);
		expect(followReads.mock.calls.filter(([userId]) => userId === strangerId)).toEqual([]);
		expect(relationshipReads.mock.calls.filter(([, , type]) => type !== RelationshipTypes.BLOCKED)).toEqual([]);
	});

	it('a stranger without profile access comments on a public post only from a verified, claimed account at least 24 hours old', async () => {
		const [author, fresh, friend] = [
			await createTestAccount(harness),
			await createTestAccount(harness),
			await createTestAccount(harness),
		];
		const unverified = await createTestAccount(harness, {skipEmailVerification: true});
		await createFriendship(harness, author, friend);
		await setLevel(author, 100);
		const post = await createPost(harness, author, {content: 'açık', public: true}).execute();
		const comment = (viewer: TestAccount) =>
			createBuilder(harness, viewer.token).post(`/feed/posts/${post.id}/comments`).body({content: 'selam'});

		await comment(fresh).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
		await comment(unverified).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.EMAIL_VERIFICATION_REQUIRED).execute();
		// Profile access keeps today's rule: a friend comments however new the account.
		await comment(friend).expect(HTTP_STATUS.OK).execute();
		await comment(author).expect(HTTP_STATUS.OK).execute();
	});

	it('an account comments at most 20 times on a public post it did not write; the author and non-public posts are not capped', async () => {
		const [author, friend] = [await createTestAccount(harness), await createTestAccount(harness)];
		await createFriendship(harness, author, friend);
		await setLevel(author, 0);
		const closed = await createPost(harness, author, {content: 'gizli'}).execute();
		await setLevel(author, 100);
		const open = await createPost(harness, author, {content: 'açık', public: true}).execute();
		const comment = (viewer: TestAccount, postId: string) =>
			createBuilder(harness, viewer.token).post(`/feed/posts/${postId}/comments`).body({content: 'selam'});

		for (let index = 0; index < 20; index++) await comment(friend, open.id).expect(HTTP_STATUS.OK).execute();
		await comment(friend, open.id).expect(TOO_MANY_REQUESTS, APIErrorCodes.RATE_LIMITED).execute();
		for (let index = 0; index < 21; index++) await comment(author, open.id).expect(HTTP_STATUS.OK).execute();
		for (let index = 0; index < 21; index++) await comment(friend, closed.id).expect(HTTP_STATUS.OK).execute();
	});

	for (const blocker of ['author', 'viewer'] as const) {
		it(`hides a public post as not found when the ${blocker} blocks`, async () => {
			const [author, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
			const {post, commentId} = await postWithComment(author, {content: 'açık', public: true});
			await (blocker === 'author'
				? blockUser(harness, author, viewer.userId)
				: blockUser(harness, viewer, author.userId));
			for (const route of postRoutes(post.id, commentId)) {
				await call(viewer, route).expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST).execute();
			}
		});
	}

	for (const flag of ['DISABLED', 'DELETED', 'DISABLED_SUSPICIOUS_ACTIVITY', 'SELF_DELETED'] as const) {
		it(`hides the public posts of a ${flag} author as not found`, async () => {
			const [author, viewer] = [await createTestAccount(harness), await createTestAccount(harness)];
			await setLevel(author, 100);
			const post = await createPost(harness, author, {content: 'açık', public: true}).execute();
			const id = createUserID(BigInt(author.userId));
			const user = (await getUserRepository().findUnique(id))!;
			await getUserRepository().patchUpsert(id, {flags: user.flags | UserFlags[flag]}, user.toRow());
			await call(viewer, postRoutes(post.id)[0]!)
				.expect(HTTP_STATUS.NOT_FOUND, APIErrorCodes.UNKNOWN_FEED_POST)
				.execute();
		});
	}

	it("falls back to the profile rule for a spammer's public post", async () => {
		const [author, stranger] = [await createTestAccount(harness), await createTestAccount(harness)];
		await setLevel(author, 100);
		const post = await createPost(harness, author, {content: 'açık', public: true}).execute();
		const id = createUserID(BigInt(author.userId));
		const user = (await getUserRepository().findUnique(id))!;
		await getUserRepository().patchUpsert(id, {flags: user.flags | UserFlags.SPAMMER}, user.toRow());
		await call(stranger, postRoutes(post.id)[0]!).expect(HTTP_STATUS.FORBIDDEN, APIErrorCodes.MISSING_ACCESS).execute();
	});

	it('keeps a shared-community reader on the old path for non-public posts', async () => {
		const {owner: author, members} = await setupTestGuildWithMembers(harness, 1);
		await setLevel(author, 0);
		const post = await createPost(harness, author, {content: 'gizli'}).execute();
		await createBuilder(harness, members[0]!.token).get(`/feed/posts/${post.id}`).expect(HTTP_STATUS.OK).execute();
	});
});
