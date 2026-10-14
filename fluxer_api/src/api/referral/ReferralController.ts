// SPDX-License-Identifier: AGPL-3.0-or-later

import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {ReferralRateLimitConfigs} from '@app/api/rate_limit_configs/ReferralRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {ReferralMeResponse} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';

// Only @me: no route takes another account ID and no public code lookup exists.
export function ReferralController(app: HonoApp) {
	app.get(
		'/users/@me/referral',
		RateLimitMiddleware(ReferralRateLimitConfigs.REFERRAL_ME),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'get_my_referral',
			summary: 'Get my referral programme',
			description:
				'Returns the own referral code (created on first read while the programme is open), the pending, valid and rejected referral counts, the enabled tiers and the rewards earned.',
			responseSchema: ReferralMeResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: ['Users'],
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			return ctx.json(await ctx.get('referralService').getMe(ctx.get('user').id));
		},
	);
}
