// SPDX-License-Identifier: AGPL-3.0-or-later

import {FeedEnabled} from '@app/api/feed/FeedPostController';
import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {FeedSuggestionsResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';

// the suggestions under the feed profile card, from this process's pool copy.
export function FeedSuggestionController(app: HonoApp) {
	app.get(
		'/feed/suggestions',
		RateLimitMiddleware(RateLimitConfigs.FEED_SUGGESTIONS),
		LoginRequired,
		DefaultUserOnly,
		FeedEnabled,
		OpenAPI({
			operationId: 'get_feed_suggestions',
			summary: 'Get feed suggestions',
			description:
				'Returns up to five popular accounts to follow and five popular Discovery communities to join, picked at random each time from lists rebuilt about once a minute. Accounts come only for an adult caller who may follow strangers (a verified email, a claimed account at least a day old); the caller, accounts the caller follows, accounts that block the caller either way and communities the caller is in are left out. 403 while suggestions are off.',
			responseSchema: FeedSuggestionsResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Feed'],
		}),
		async (ctx) => {
			const service = ctx.get('feedSuggestionService');
			const user = ctx.get('user');
			if (!service.isEnabledFor(user)) throw new FeatureTemporarilyDisabledError();
			return ctx.json(await service.suggest(user));
		},
	);
}
