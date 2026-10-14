// SPDX-License-Identifier: AGPL-3.0-or-later

import {requireEmailVerified} from '@app/api/auth/EmailVerificationUtils';
import type {FeedPostRow} from '@app/api/database/types/FeedTypes';
import {FeedEnabled, requirePostViewAccess} from '@app/api/feed/FeedPostController';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import type {User} from '@app/api/models/User';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import {type IARSubmission, reportStatusToString} from '@app/api/report/ReportModels';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {UnknownFeedCommentError} from '@fluxer/errors/src/domains/content/UnknownFeedCommentError';
import {UnknownFeedPostError} from '@fluxer/errors/src/domains/content/UnknownFeedPostError';
import {UnclaimedAccountCannotSubmitReportsError} from '@fluxer/errors/src/domains/moderation/UnclaimedAccountCannotSubmitReportsError';
import {ReportFeedCommentRequest, ReportFeedPostRequest} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import {ReportResponse} from '@fluxer/schema/src/domains/report/ReportSchemas';
import type {Context} from 'hono';

// The reporter needs the account checks of the other report routes and the post's own read access
// (requirePostViewAccess; a block either way answers 404 like the post).
async function loadReportablePost(ctx: Context<HonoEnv>, postId: bigint): Promise<{reporter: User; post: FeedPostRow}> {
	const reporter = ctx.get('user');
	if (reporter.isUnclaimedAccount()) {
		throw new UnclaimedAccountCannotSubmitReportsError();
	}
	requireEmailVerified(reporter, 'report');
	const post = await ctx.get('feedTimelineService').getPost(postId);
	if (!post) {
		throw new UnknownFeedPostError();
	}
	await requirePostViewAccess(ctx, post, () => new UnknownFeedPostError());
	return {reporter, post};
}

function reporterOf(user: User) {
	return {id: user.id, email: user.email, fullLegalName: null, countryOfResidence: null};
}

function toReportResponse(report: IARSubmission): ReportResponse {
	return {
		report_id: report.reportId.toString(),
		status: reportStatusToString(report.status),
		reported_at: report.reportedAt.toISOString(),
	};
}

export function FeedReportController(app: HonoApp) {
	app.post(
		'/reports/feed-post',
		RateLimitMiddleware(RateLimitConfigs.REPORT_CREATE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('json', ReportFeedPostRequest),
		OpenAPI({
			operationId: 'report_feed_post',
			summary: 'Report feed post',
			description:
				'Submits a report about a feed post to moderators for content violation review. The reporter must be able to see the post.',
			responseSchema: ReportResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Reports',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {post_id, category} = ctx.req.valid('json');
			const {reporter, post} = await loadReportablePost(ctx, post_id);
			// Marked before the report is filed, so no report of a video exists without its evidence key; the copy
			// itself is queued only for a report that was filed, and a refused report's key lapses in 5 minutes.
			const videos = ctx.get('feedVideoService');
			await videos.markReported(post, {pending: true});
			const report = await ctx.get('reportService').reportFeedPost(reporterOf(reporter), post, category);
			await videos.keepReportedEvidence(post);
			await ctx.get('feedPostService').trend.recordReport(reporter, post);
			return ctx.json(toReportResponse(report));
		},
	);
	app.post(
		'/reports/feed-comment',
		RateLimitMiddleware(RateLimitConfigs.REPORT_CREATE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('json', ReportFeedCommentRequest),
		OpenAPI({
			operationId: 'report_feed_comment',
			summary: 'Report feed comment',
			description:
				'Submits a report about a comment on a feed post to moderators for content violation review. The reporter must be able to see the post.',
			responseSchema: ReportResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Reports',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {post_id, comment_id, parent_comment_id, category} = ctx.req.valid('json');
			const {reporter, post} = await loadReportablePost(ctx, post_id);
			const interactions = ctx.get('feedInteractionService');
			// A reply names its top-level comment, which the report shows before it: the moderator's reply delete route
			// takes both IDs.
			const parent = parent_comment_id === undefined ? null : await interactions.getComment(post_id, parent_comment_id);
			const reply = parent ? await interactions.getReply(post_id, parent.comment_id, comment_id) : null;
			const comment =
				parent_comment_id === undefined
					? await interactions.getComment(post_id, comment_id)
					: reply && {
							comment_id: reply.reply_id,
							author_id: reply.author_id,
							content: reply.content,
							edited_at: reply.edited_at,
						};
			if (!comment) {
				throw new UnknownFeedCommentError();
			}
			// The report shows the post's media too, so a video's evidence is kept as for a post report.
			const videos = ctx.get('feedVideoService');
			await videos.markReported(post, {pending: true});
			const report = await ctx
				.get('reportService')
				.reportFeedComment(reporterOf(reporter), post, comment, category, parent);
			await videos.keepReportedEvidence(post);
			return ctx.json(toReportResponse(report));
		},
	);
}
