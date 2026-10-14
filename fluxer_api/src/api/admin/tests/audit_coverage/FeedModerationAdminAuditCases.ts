// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createPost} from '@app/api/feed/tests/FeedTestUtils';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {FeedCommentResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

const NO_CONTENT = 204;

export const FeedModerationAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'DELETE',
		route: '/admin/feed/posts/:post_id',
		async prepare({harness}) {
			const author = await createTestAccount(harness);
			const post = await createPost(harness, author, {content: 'moderation target'}).execute();
			return {
				request: {path: `/admin/feed/posts/${post.id}`, expectStatus: NO_CONTENT},
				expected: {
					action: 'delete_feed_post',
					targetType: 'feed_post',
					targetId: post.id,
					metadata: {author_id: author.userId},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/feed/posts/:post_id/discover-hide',
		async prepare({harness}) {
			const author = await createTestAccount(harness);
			const post = await createPost(harness, author, {content: 'restore target', public: true}).execute();
			return {
				request: {path: `/admin/feed/posts/${post.id}/discover-hide`, expectStatus: NO_CONTENT},
				expected: {
					action: 'restore_feed_post_discover',
					targetType: 'feed_post',
					targetId: post.id,
					metadata: {author_id: author.userId},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/feed/posts/:post_id/comments/:comment_id',
		async prepare({harness}) {
			const author = await createTestAccount(harness);
			const post = await createPost(harness, author, {content: 'commented post'}).execute();
			const comment = await createBuilder<FeedCommentResponse>(harness, author.token)
				.post(`/feed/posts/${post.id}/comments`)
				.body({content: 'moderation target'})
				.execute();
			return {
				request: {path: `/admin/feed/posts/${post.id}/comments/${comment.id}`, expectStatus: NO_CONTENT},
				expected: {
					action: 'delete_feed_comment',
					targetType: 'feed_comment',
					targetId: comment.id,
					metadata: {post_id: post.id, author_id: author.userId},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/feed/posts/:post_id/comments/:comment_id/replies/:reply_id',
		async prepare({harness}) {
			const author = await createTestAccount(harness);
			const post = await createPost(harness, author, {content: 'replied post'}).execute();
			const comment = await createBuilder<FeedCommentResponse>(harness, author.token)
				.post(`/feed/posts/${post.id}/comments`)
				.body({content: 'parent comment'})
				.execute();
			const reply = await createBuilder<FeedCommentResponse>(harness, author.token)
				.post(`/feed/posts/${post.id}/comments/${comment.id}/replies`)
				.body({content: 'moderation target'})
				.execute();
			return {
				request: {
					path: `/admin/feed/posts/${post.id}/comments/${comment.id}/replies/${reply.id}`,
					expectStatus: NO_CONTENT,
				},
				expected: {
					action: 'delete_feed_comment_reply',
					targetType: 'feed_comment',
					targetId: reply.id,
					metadata: {post_id: post.id, parent_id: comment.id, author_id: author.userId},
				},
			};
		},
	},
];
