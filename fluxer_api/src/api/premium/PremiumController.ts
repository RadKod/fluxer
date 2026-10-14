// SPDX-License-Identifier: AGPL-3.0-or-later

import {DefaultUserOnly, LoginRequired} from '@app/api/middleware/AuthMiddleware';
import {CaptchaMiddleware} from '@app/api/middleware/CaptchaMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {spendPremiumTrialNetworkQuota} from '@app/api/premium/trial/PremiumTrialNetworkRateLimit';
import {RateLimitConfigs} from '@app/api/RateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {assertAccountNotLimited} from '@app/api/user/AccountLimit';
import {lookupGeoip} from '@app/api/utils/IpUtils';
import {Validator} from '@app/api/Validator';
import {
	PremiumStateQueryRequest,
	PremiumStateResponse,
	UpdatePremiumPerksDisabledRequest,
} from '@fluxer/schema/src/domains/premium/PremiumSchemas';
import {PremiumTrialEligibilityResponse} from '@fluxer/schema/src/domains/premium/PremiumTrialSchemas';

export function PremiumController(app: HonoApp) {
	app.get(
		'/premium/state',
		RateLimitMiddleware(RateLimitConfigs.STRIPE_PREMIUM_STATE),
		LoginRequired,
		DefaultUserOnly,
		Validator('query', PremiumStateQueryRequest),
		OpenAPI({
			operationId: 'get_premium_state',
			summary: 'Get premium state',
			description:
				'Returns the authenticated user actual premium entitlement, effective perk state, and mirrored billing data. When Stripe is enabled, missing payment-method mirror data may be repaired lazily.',
			responseSchema: PremiumStateResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Premium',
		}),
		async (ctx) => {
			const userId = ctx.get('user').id;
			const {country_code} = ctx.req.valid('query');
			const geoip = await lookupGeoip(ctx.req.raw);
			const state = await ctx.get('stripeService').getPremiumState(userId, geoip.countryCode ?? country_code);
			return ctx.json(state);
		},
	);
	app.patch(
		'/premium/perks-disabled',
		RateLimitMiddleware(RateLimitConfigs.STRIPE_PREMIUM_PERKS_DISABLED),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'set_premium_perks_disabled',
			summary: 'Set premium perks disabled',
			description:
				'Temporarily disables or restores premium perks for the authenticated user while preserving actual subscription and billing state.',
			responseSchema: PremiumStateResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Premium',
		}),
		Validator('json', UpdatePremiumPerksDisabledRequest),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			const userId = ctx.get('user').id;
			const {disabled} = ctx.req.valid('json');
			const state = await ctx.get('stripeService').setPremiumPerksDisabled(userId, disabled);
			return ctx.json(state);
		},
	);
	app.get(
		'/premium/trial',
		RateLimitMiddleware(RateLimitConfigs.PREMIUM_TRIAL_GET),
		LoginRequired,
		DefaultUserOnly,
		OpenAPI({
			operationId: 'get_premium_trial',
			summary: 'Get premium trial eligibility',
			description:
				'Returns whether the authenticated user can start the one-time free premium trial, its length in days, and why not when they cannot.',
			responseSchema: PremiumTrialEligibilityResponse,
			statusCode: 200,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Premium',
		}),
		async (ctx) => {
			return ctx.json(await ctx.get('premiumTrialService').getEligibility(ctx.get('user')));
		},
	);
	app.post(
		'/premium/trial',
		RateLimitMiddleware(RateLimitConfigs.PREMIUM_TRIAL_CLAIM),
		LoginRequired,
		DefaultUserOnly,
		CaptchaMiddleware,
		OpenAPI({
			operationId: 'start_premium_trial',
			summary: 'Start premium trial',
			description:
				'Starts the one-time free premium trial for the authenticated user without a payment method. Each account and each normalised email address can start it once; the instance must enable it and the configured CAPTCHA policy applies.',
			responseSchema: null,
			statusCode: 204,
			security: ['bearerToken', 'sessionToken'],
			tags: 'Premium',
		}),
		async (ctx) => {
			assertAccountNotLimited(ctx.get('user'));
			await ctx.get('premiumTrialService').claim(ctx.get('user'), () => spendPremiumTrialNetworkQuota(ctx));
			return ctx.body(null, 204);
		},
	);
}
