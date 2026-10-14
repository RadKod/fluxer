// SPDX-License-Identifier: AGPL-3.0-or-later

import {FeedEnabled} from '@app/api/feed/FeedPostController';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {FeedNotificationAckRequest, FeedNotificationsQuery} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import {
	FeedNotificationAckResponse,
	FeedNotificationListResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

export function FeedNotificationController(app: HonoApp) {
	app.get(
		'/feed/notifications',
		RateLimitMiddleware(RateLimitConfigs.FEED_NOTIFICATIONS),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('query', FeedNotificationsQuery),
		OpenAPI({
			operationId: 'list_feed_notifications',
			summary: 'List feed notifications',
			description:
				'Returns one page of the likes, comments and follows aimed at the current user, newest first, kept for 90 days. Actions of one kind on one post within an hour fold into one notification; FEED_NOTIFICATION_CREATE carries new ones.',
			responseSchema: FeedNotificationListResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const {before, limit} = ctx.req.valid('query');
			return ctx.json(
				await ctx
					.get('feedNotificationService')
					.listNotifications(ctx.get('user').id, {before, limit}, ctx.get('requestCache')),
			);
		},
	);
	app.post(
		'/feed/notifications/ack',
		RateLimitMiddleware(RateLimitConfigs.FEED_NOTIFICATION_ACK),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('json', FeedNotificationAckRequest),
		OpenAPI({
			operationId: 'ack_feed_notifications',
			summary: 'Mark feed notifications read',
			description:
				"Moves the current user's notification read cursor forward to read_at, never back and never past the server time, reads the unread sequence up to unread_seq, and sends FEED_NOTIFICATION_ACK to the user's sessions. READY carries the cursor and the unread count.",
			responseSchema: FeedNotificationAckResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const {read_at, unread_seq, unread_epoch} = ctx.req.valid('json');
			return ctx.json(
				await ctx
					.get('feedNotificationService')
					.markRead(ctx.get('user').id, new Date(read_at), unread_seq, unread_epoch),
			);
		},
	);
}
