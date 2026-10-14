// SPDX-License-Identifier: AGPL-3.0-or-later

import {FeedEnabled} from '@app/api/feed/FeedPostController';
import {opensPublicPostsToStrangers} from '@app/api/feed/FeedTimelineService';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import * as FetchUtils from '@app/api/utils/FetchUtils';
import {Validator} from '@app/api/Validator';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {BadRequestError} from '@fluxer/errors/src/domains/core/BadRequestError';
import {FeedVideoCreateRequest, FeedVideoIdParam} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import {
	FeedPendingVideoListResponse,
	FeedVideoUploadResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {WebhookReceivedResponse} from '@fluxer/schema/src/domains/premium/PremiumSchemas';

// Bunny's webhook body is three fields.
const WEBHOOK_MAX_BYTES = 4096;

export function FeedVideoController(app: HonoApp) {
	app.post(
		'/feed/videos',
		RateLimitMiddleware(RateLimitConfigs.FEED_VIDEO_CREATE),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('json', FeedVideoCreateRequest),
		OpenAPI({
			operationId: 'create_feed_video',
			summary: 'Start a feed video upload',
			description:
				'Starts one video post (up to 500 MB) through Bunny Stream while feature_feed_video is on and returns the TUS upload ticket, signed for 2 hours. It uses up one post of the day at once; at most 3 videos can be on their way. The video becomes a post only after Bunny has encoded it and it passes the content scan.',
			responseSchema: FeedVideoUploadResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const user = ctx.get('user');
			// as POST /feed/posts, the public bit comes from the author's level, not the request.
			const isPublic = opensPublicPostsToStrangers(await ctx.get('userRepository').findSettings(user.id), user);
			return ctx.json(await ctx.get('feedVideoService').start(user, {...ctx.req.valid('json'), public: isPublic}));
		},
	);
	app.post(
		'/feed/videos/:video_id/signature',
		RateLimitMiddleware(RateLimitConfigs.FEED_VIDEO_SIGN),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedVideoIdParam),
		OpenAPI({
			operationId: 'resign_feed_video_upload',
			summary: 'Re-sign a feed video upload',
			description:
				'Returns a fresh TUS upload ticket for one of the caller videos that is still uploading, within 6 hours of its start.',
			responseSchema: FeedVideoUploadResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			return ctx.json(await ctx.get('feedVideoService').resign(ctx.get('user'), ctx.req.valid('param').video_id));
		},
	);
	app.delete(
		'/feed/videos/:video_id',
		RateLimitMiddleware(RateLimitConfigs.FEED_VIDEO_CANCEL),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('param', FeedVideoIdParam),
		OpenAPI({
			operationId: 'cancel_feed_video',
			summary: 'Cancel a feed video',
			description:
				'Cancels one of the caller videos that is not a post yet and deletes it from Bunny Stream. A posted video goes with its post.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			await ctx.get('feedVideoService').cancel(ctx.get('user'), ctx.req.valid('param').video_id);
			return ctx.body(null, 204);
		},
	);
	app.get(
		'/feed/videos',
		RateLimitMiddleware(RateLimitConfigs.FEED_VIDEO_LIST),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		OpenAPI({
			operationId: 'list_feed_videos',
			summary: 'List feed videos on their way',
			description:
				'Returns up to 20 of the caller videos, newest first: those uploading, processing or being checked, and those posted in the last hour with their post ID.',
			responseSchema: FeedPendingVideoListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => ctx.json(await ctx.get('feedVideoService').listPending(ctx.get('user'))),
	);
	app.post(
		'/feed/videos/webhook',
		RateLimitMiddleware(RateLimitConfigs.FEED_VIDEO_WEBHOOK),
		OpenAPI({
			operationId: 'process_bunny_stream_webhook',
			summary: 'Process Bunny Stream webhook',
			description:
				'Receives Bunny Stream video status changes. The raw body (up to 4 KiB) must carry a v1 HMAC-SHA256 signature made with the library read-only API key; events of another library or an unknown status are acknowledged and ignored.',
			responseSchema: WebhookReceivedResponse,
			statusCode: 200,
			security: [],
			tags: ['Feed'],
		}),
		async (ctx) => {
			// A capped stream (the content filter skips this route): neither a Content-Length over 4 KiB nor a chunked
			// body without one is read past the limit.
			let rawBody: string;
			try {
				rawBody = await FetchUtils.streamToStringWithLimit(ctx.req.raw.body, {
					maxBytes: WEBHOOK_MAX_BYTES,
					headers: ctx.req.raw.headers,
				});
			} catch (error) {
				if (error instanceof FetchUtils.ResponseBodyTooLargeError) {
					throw new BadRequestError({code: APIErrorCodes.INVALID_REQUEST});
				}
				throw error;
			}
			await ctx.get('feedVideoService').acceptWebhook(rawBody, {
				signature: ctx.req.header('x-bunnystream-signature'),
				version: ctx.req.header('x-bunnystream-signature-version'),
				algorithm: ctx.req.header('x-bunnystream-signature-algorithm'),
			});
			return ctx.json({received: true});
		},
	);
}
