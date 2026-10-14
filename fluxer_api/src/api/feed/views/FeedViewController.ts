// SPDX-License-Identifier: AGPL-3.0-or-later

import {FeedEnabled} from '@app/api/feed/FeedPostController';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {Validator} from '@app/api/Validator';
import {FeedViewsRequest} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';

export function FeedViewController(app: HonoApp) {
	app.post(
		'/feed/views',
		RateLimitMiddleware(RateLimitConfigs.FEED_VIEWS),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		Validator('json', FeedViewsRequest),
		OpenAPI({
			operationId: 'record_feed_post_views',
			summary: 'Record feed post views',
			description:
				'Counts the posts the caller saw, each with the view_token its response carried. One batch a minute per account; a post counts at most once a minute for an account. Invalid tickets are dropped silently. 403 while view counts are off.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			await ctx.get('feedViewService').record(ctx.get('user').id, ctx.req.valid('json').views);
			return ctx.body(null, 204);
		},
	);
}
