// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {setupTestGuildWithMembers} from '@app/api/channel/tests/ChannelTestUtils';
import {createPost, overrideLimits} from '@app/api/feed/tests/FeedTestUtils';
import {
	getFeedNotificationService,
	getUserCacheService,
	getUserRepository,
} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {
	FeedCommentResponse,
	FeedNotificationListResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

describe('feed notification referenced content cutoff', () => {
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
	it('matches aggregate latest comment to its actor, hides parent or latest content separately and restores', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 2);
		const [olderActor, latestActor] = members as [TestAccount, TestAccount];
		const post = await createPost(harness, owner, {content: 'notification parent'}).execute();
		const now = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const older = await createBuilder<FeedCommentResponse>(harness, olderActor.token)
			.post(`/feed/posts/${post.id}/comments`)
			.body({content: 'older actor comment'})
			.execute();
		clock.mockReturnValue(now + 1);
		const latest = await createBuilder<FeedCommentResponse>(harness, latestActor.token)
			.post(`/feed/posts/${post.id}/comments`)
			.body({content: 'latest actor comment'})
			.execute();
		await getFeedNotificationService().aggregate({
			recipientId: createUserID(BigInt(owner.userId)),
			type: 'post_comment',
			postId: BigInt(post.id),
			hour: Math.floor(now / 3_600_000),
		});
		const inbox = () =>
			createBuilder<FeedNotificationListResponse>(harness, owner.token).get('/feed/notifications').execute();
		const [initial] = await inbox();
		expect(initial).toMatchObject({post_id: post.id, comment_id: latest.id, actor_count: 2});
		expect(initial!.actors.map((actor) => actor.id)).toEqual([latestActor.userId, olderActor.userId]);
		await mark(olderActor, snowflakeToDate(BigInt(older.id)));
		expect(await inbox()).toEqual([initial]);
		await mark(latestActor, snowflakeToDate(BigInt(latest.id)));
		expect(await inbox()).toEqual([]);
		await mark(latestActor, null);
		expect(await inbox()).toEqual([initial]);
		await mark(owner, snowflakeToDate(BigInt(post.id)));
		expect(await inbox()).toEqual([]);
		await mark(owner, null);
		const restored = await inbox();
		expect(restored).toEqual([initial]);
		expect(JSON.stringify(restored)).not.toContain('content_hidden_since');
	});

	it('does not load private visibility metadata for a follow-only inbox', async () => {
		const {owner, members} = await setupTestGuildWithMembers(harness, 1);
		const actor = members[0]!;
		const now = Date.now();
		const service = getFeedNotificationService();
		await service.record({
			recipientId: createUserID(BigInt(owner.userId)),
			actorId: createUserID(BigInt(actor.userId)),
			type: 'follow',
			postId: null,
		});
		await service.aggregate({
			recipientId: createUserID(BigInt(owner.userId)),
			type: 'follow',
			postId: 0n,
			hour: Math.floor(now / 3_600_000),
		});
		const metadata = vi.spyOn(getUserCacheService(), 'getContentHiddenSince');
		const inbox = await createBuilder<FeedNotificationListResponse>(harness, owner.token)
			.get('/feed/notifications')
			.execute();
		expect(inbox).toEqual([expect.objectContaining({type: 'follow', post_id: null, comment_id: null})]);
		expect(metadata.mock.calls.flatMap(([ids]) => ids)).toEqual([]);
	});

	it.each(['reply', 'parent', 'older_reply'] as const)(
		'hides reply notification when the %s content is covered',
		async (hidden) => {
			const {owner, members} = await setupTestGuildWithMembers(harness, 2);
			const [parentAuthor, replyAuthor] = members as [TestAccount, TestAccount];
			overrideLimits({feature_feed_reply_notifications: 1});
			const post = await createPost(harness, owner, {content: 'reply notification post'}).execute();
			const parent = await createBuilder<FeedCommentResponse>(harness, parentAuthor.token)
				.post(`/feed/posts/${post.id}/comments`)
				.body({content: 'older parent'})
				.execute();
			const reply = await createBuilder<FeedCommentResponse>(harness, replyAuthor.token)
				.post(`/feed/posts/${post.id}/comments/${parent.id}/replies`)
				.body({content: 'newer reply'})
				.execute();
			const service = getFeedNotificationService();
			await service.aggregate({
				recipientId: createUserID(BigInt(parentAuthor.userId)),
				type: 'comment_reply',
				postId: BigInt(post.id),
				hour: Math.floor(Date.now() / 3_600_000),
			});
			const inbox = () =>
				createBuilder<FeedNotificationListResponse>(harness, parentAuthor.token).get('/feed/notifications').execute();
			const initial = await inbox();
			expect(initial).toEqual([expect.objectContaining({type: 'comment_reply', comment_id: parent.id})]);
			const author = hidden === 'parent' ? parentAuthor : replyAuthor;
			const cutoff =
				hidden === 'older_reply'
					? new Date(Date.now() + 86_400_000)
					: snowflakeToDate(BigInt(hidden === 'reply' ? reply.id : parent.id));
			await mark(author, cutoff);
			expect(await inbox()).toEqual([]);
			await mark(author, null);
			expect(await inbox()).toEqual(initial);
		},
	);
});
