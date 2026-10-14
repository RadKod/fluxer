// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {CosmeticController} from '@app/api/cosmetics/CosmeticController';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {FeedPostController} from '@app/api/feed/FeedPostController';
import {FeedInteractionController} from '@app/api/feed/interaction/FeedInteractionController';
import {FeedReportController} from '@app/api/feed/moderation/FeedReportController';
import {FeedNotificationController} from '@app/api/feed/notification/FeedNotificationController';
import {FeedVideoController} from '@app/api/feed/video/FeedVideoController';
import {FeedViewController} from '@app/api/feed/views/FeedViewController';
import {FollowController} from '@app/api/follow/FollowController';
import {MicupBotController} from '@app/api/guild/micupbot/MicupBotController';
import {GuildRosterController} from '@app/api/guild/roster/GuildRosterController';
import {LoginRequired, LoginRequiredAllowSuspicious} from '@app/api/middleware/AuthMiddleware';
import {User} from '@app/api/models/User';
import {OAuth2ApplicationsController} from '@app/api/oauth/OAuth2ApplicationsController';
import {PremiumController} from '@app/api/premium/PremiumController';
import {ReferralController} from '@app/api/referral/ReferralController';
import {ShopOrderController} from '@app/api/shop/ShopOrderController';
import {StoreBillingController} from '@app/api/store_billing/StoreBillingController';
import {GiftCodeRoutes, StripeController} from '@app/api/stripe/StripeController';
import {TableGameController} from '@app/api/table_game/TableGameController';
import type {HonoApp, HonoEnv} from '@app/api/types/HonoEnv';
import {VoiceSeatController} from '@app/api/voice_seat/VoiceSeatController';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import {Hono, type MiddlewareHandler} from 'hono';
import {describe, expect, it} from 'vitest';

interface WriteRoute {
	method: string;
	path: string;
	handler: MiddlewareHandler<HonoEnv>;
}

// Exercise each validated route handler through HTTP. Validation, rate limits and
// feature switches have their own tests; no business service is installed here,
// so rejection must happen before any service can read or mutate state.
function writeRoutes(): Array<WriteRoute> {
	const routes: Array<WriteRoute> = [];
	const registry = Object.fromEntries(
		['get', 'post', 'put', 'patch', 'delete'].map((method) => [
			method,
			(path: string, ...handlers: Array<MiddlewareHandler<HonoEnv>>) => {
				if (method === 'delete' && path === '/oauth2/applications/:id') return;
				const mutates = method !== 'get' || ['/users/@me/referral', '/premium/store'].includes(path);
				if ((handlers.includes(LoginRequired) || handlers.includes(LoginRequiredAllowSuspicious)) && mutates) {
					routes.push({method: method.toUpperCase(), path, handler: handlers.at(-1)!});
				}
			},
		]),
	) as unknown as HonoApp;
	for (const controller of [
		CosmeticController,
		FeedPostController,
		FeedInteractionController,
		FeedReportController,
		FeedNotificationController,
		FeedVideoController,
		FeedViewController,
		FollowController,
		MicupBotController,
		GuildRosterController,
		OAuth2ApplicationsController,
		PremiumController,
		ReferralController,
		ShopOrderController,
		StoreBillingController,
		GiftCodeRoutes,
		StripeController,
		TableGameController,
		VoiceSeatController,
	]) {
		controller(registry);
	}
	return routes;
}

describe('sanalyer write route account limits', () => {
	it.each(
		writeRoutes().flatMap((route) =>
			[
				{restriction: 'upstream limited', flags: UserFlags.ACCOUNT_LIMITED, suspicious_activity_flags: 0},
				{restriction: 'legacy unverified phone', flags: 0n, suspicious_activity_flags: 4, has_verified_phone: false},
				{restriction: 'legacy phone reverification', flags: 0n, suspicious_activity_flags: 8, has_verified_phone: true},
				{restriction: 'legacy exempt account', flags: UserFlags.LIMIT_EXEMPT, suspicious_activity_flags: 4},
			].map((restriction) => ({...route, ...restriction})),
		),
	)('$method $path refuses $restriction before business services', async (route) => {
		const app = new Hono<HonoEnv>();
		app.use('*', async (ctx, next) => {
			ctx.set(
				'user',
				new User({
					...EMPTY_USER_ROW,
					...route,
					user_id: createUserID(123n),
					email: 'legacy@example.com',
				}),
			);
			await next();
		});
		app.onError((error, ctx) =>
			error instanceof FluxerError ? error.getResponse() : ctx.json({code: 'UNEXPECTED_SERVICE_ACCESS'}, 500),
		);
		app.on(route.method, route.path, route.handler);
		const response = await app.request(route.path.replace(/:[a-z_]+/g, '123'), {method: route.method});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({code: 'ACCOUNT_LIMITED'});
	});
});
