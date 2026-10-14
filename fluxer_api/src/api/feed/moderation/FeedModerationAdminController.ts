// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {type FeedAuthorDmKey, sendFeedAuthorDm} from '@app/api/feed/FeedAuthorDm';
import {feedStreamEvidenceKey, isStreamMedia} from '@app/api/feed/video/FeedVideoUrls';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UnknownFeedCommentError} from '@fluxer/errors/src/domains/content/UnknownFeedCommentError';
import {UnknownFeedPostError} from '@fluxer/errors/src/domains/content/UnknownFeedPostError';
import {
	FeedPostIdCommentIdParam,
	FeedPostIdCommentIdReplyIdParam,
	FeedPostIdParam,
} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import type {Context} from 'hono';

// The author learns of the removal through a system DM, queued on the existing sendSystemDm job in their locale.
function notifyAuthor(ctx: Context<HonoEnv>, authorId: UserID, key: FeedAuthorDmKey): Promise<void> {
	return sendFeedAuthorDm({users: ctx.get('userRepository'), worker: ctx.get('workerService')}, authorId, key);
}

export function FeedModerationAdminController(app: HonoApp) {
	app.delete(
		'/admin/feed/posts/:post_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_FEED_MODERATION),
		requireAdminACL(AdminACLs.FEED_MODERATE),
		Validator('param', FeedPostIdParam),
		OpenAPI({
			operationId: 'delete_admin_feed_post',
			summary: 'Delete feed post',
			description:
				'Removes a feed post with its images or video, likes and comments as a moderator, keeping a copy of the images and video in the reports bucket, logs it to the audit log and tells its author through a system DM. Home feeds drop it on their next read. Requires FEED_MODERATE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const post = await ctx.get('feedTimelineService').getPost(ctx.req.valid('param').post_id);
			if (!post) {
				throw new UnknownFeedPostError();
			}
			const feedPostService = ctx.get('feedPostService');
			const media = post.media ?? [];
			// The report path keeps a reported post's images; a removal without a report keeps them here. A Bunny video's
			// evidence is joined by the priority delete job under its key before Bunny deletes it; removePost records
			// the key first, so a plain delete that took the job key (account deletion) joins it too.
			const evidenceKeys = [
				...(await feedPostService.media.keepEvidence(post.author_id, media)),
				...media.filter(isStreamMedia).map((item) => feedStreamEvidenceKey(post.author_id, item)),
			];
			await feedPostService.removePost(post, {priority: true});
			const metadata = new Map([['author_id', post.author_id.toString()]]);
			if (evidenceKeys.length > 0) metadata.set('evidence_keys', evidenceKeys.join(','));
			await ctx.get('adminService').auditService.createAuditLog({
				adminUserId: ctx.get('adminUserId'),
				targetType: 'feed_post',
				targetId: post.post_id,
				action: 'delete_feed_post',
				auditLogReason: ctx.get('auditLogReason'),
				metadata,
			});
			await notifyAuthor(ctx, post.author_id, 'feed.post_removed_by_moderator');
			return ctx.body(null, 204);
		},
	);
	// Undoes the report threshold hide. No system DM: the author was never told of the hide.
	app.delete(
		'/admin/feed/posts/:post_id/discover-hide',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_FEED_MODERATION),
		requireAdminACL(AdminACLs.FEED_MODERATE),
		Validator('param', FeedPostIdParam),
		OpenAPI({
			operationId: 'restore_admin_feed_post_discover',
			summary: 'Restore feed post to Discover',
			description:
				'Undoes the report threshold hide of a public feed post: its reports are cleared, it returns to the Discover ranking with its score, and reports cannot hide it again for 72 hours. Logs it to the audit log. Requires FEED_MODERATE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const post = await ctx.get('feedTimelineService').getPost(ctx.req.valid('param').post_id);
			if (!post) {
				throw new UnknownFeedPostError();
			}
			await ctx.get('feedPostService').trend.restorePost(post.post_id);
			await ctx.get('adminService').auditService.createAuditLog({
				adminUserId: ctx.get('adminUserId'),
				targetType: 'feed_post',
				targetId: post.post_id,
				action: 'restore_feed_post_discover',
				auditLogReason: ctx.get('auditLogReason'),
				metadata: new Map([['author_id', post.author_id.toString()]]),
			});
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/admin/feed/posts/:post_id/comments/:comment_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_FEED_MODERATION),
		requireAdminACL(AdminACLs.FEED_MODERATE),
		Validator('param', FeedPostIdCommentIdParam),
		OpenAPI({
			operationId: 'delete_admin_feed_comment',
			summary: 'Delete feed comment',
			description:
				'Removes a comment on a feed post as a moderator, logs it to the audit log and tells its author through a system DM. Requires FEED_MODERATE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {post_id, comment_id} = ctx.req.valid('param');
			const interactions = ctx.get('feedInteractionService');
			const comment = await interactions.getComment(post_id, comment_id);
			if (!comment) {
				throw new UnknownFeedCommentError();
			}
			await interactions.removeComment(comment);
			await ctx.get('adminService').auditService.createAuditLog({
				adminUserId: ctx.get('adminUserId'),
				targetType: 'feed_comment',
				targetId: comment.comment_id,
				action: 'delete_feed_comment',
				auditLogReason: ctx.get('auditLogReason'),
				metadata: new Map([
					['post_id', comment.post_id.toString()],
					['author_id', comment.author_id.toString()],
				]),
			});
			await notifyAuthor(ctx, comment.author_id, 'feed.comment_removed_by_moderator');
			return ctx.body(null, 204);
		},
	);
	app.delete(
		'/admin/feed/posts/:post_id/comments/:comment_id/replies/:reply_id',
		RateLimitMiddleware(RateLimitConfigs.ADMIN_FEED_MODERATION),
		requireAdminACL(AdminACLs.FEED_MODERATE),
		Validator('param', FeedPostIdCommentIdReplyIdParam),
		OpenAPI({
			operationId: 'delete_admin_feed_comment_reply',
			summary: 'Delete feed comment reply',
			description:
				'Removes a reply to a comment on a feed post as a moderator, logs it to the audit log and tells its author through a system DM. Requires FEED_MODERATE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {post_id, comment_id, reply_id} = ctx.req.valid('param');
			const interactions = ctx.get('feedInteractionService');
			const reply = await interactions.getReply(post_id, comment_id, reply_id);
			if (!reply) {
				throw new UnknownFeedCommentError();
			}
			await interactions.removeReply(reply);
			await ctx.get('adminService').auditService.createAuditLog({
				adminUserId: ctx.get('adminUserId'),
				targetType: 'feed_comment',
				targetId: reply.reply_id,
				action: 'delete_feed_comment_reply',
				auditLogReason: ctx.get('auditLogReason'),
				metadata: new Map([
					['post_id', reply.post_id.toString()],
					['parent_id', reply.comment_id.toString()],
					['author_id', reply.author_id.toString()],
				]),
			});
			await notifyAuthor(ctx, reply.author_id, 'feed.comment_removed_by_moderator');
			return ctx.body(null, 204);
		},
	);
}
