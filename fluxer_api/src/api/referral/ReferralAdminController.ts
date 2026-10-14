// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminAuditReadActions} from '@app/api/admin/AdminAuditActions';
import {recordAdminRead, recordAdminWrite} from '@app/api/admin/AdminAuditRecorder';
import {createUserID} from '@app/api/BrandedTypes';
import {requireAdminACL} from '@app/api/middleware/AdminMiddleware';
import {RateLimitMiddleware} from '@app/api/middleware/RateLimitMiddleware';
import {OpenAPI} from '@app/api/middleware/ResponseTypeMiddleware';
import {ReferralRateLimitConfigs} from '@app/api/rate_limit_configs/ReferralRateLimitConfig';
import type {HonoApp} from '@app/api/types/HonoEnv';
import {Validator} from '@app/api/Validator';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {UserIdParam} from '@fluxer/schema/src/domains/common/CommonParamSchemas';
import {
	AdminReferralRewardParam,
	CreateReferralTierRequest,
	DeliverReferralRewardRequest,
	ListReferralPendingRewardsQuery,
	ListUserReferralsQuery,
	NotifyReferralRewardRequest,
	ReferralTierIdParam,
	UpdateReferralSettingsRequest,
	UpdateReferralTierRequest,
} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import {
	AdminReferralPendingRewardsResponse,
	AdminReferralResponse,
	AdminReferralRewardResponse,
	AdminUserReferralsResponse,
	ReferralTierResponse,
} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';

const SETTING_KEYS = ['enabled', 'min_active_days', 'daily_valid_cap', 'ip_registration_limit'] as const;
const TIER_KEYS = ['threshold', 'enabled'] as const;

// <field>_old and <field>_new for every field the update changed, like the shop settings.
function describeChange<T extends Record<string, unknown>>(
	before: T,
	after: T,
	keys: ReadonlyArray<keyof T & string>,
): Record<string, string> {
	const metadata: Record<string, string> = {};
	for (const key of keys) {
		const oldValue = String(before[key]);
		const newValue = String(after[key]);
		if (oldValue === newValue) continue;
		metadata[`${key}_old`] = oldValue;
		metadata[`${key}_new`] = newValue;
	}
	return metadata;
}

export function ReferralAdminController(app: HonoApp) {
	app.get(
		'/admin/referral',
		RateLimitMiddleware(ReferralRateLimitConfigs.ADMIN_REFERRAL),
		requireAdminACL(AdminACLs.REFERRAL_MANAGE),
		OpenAPI({
			operationId: 'get_admin_referral',
			summary: 'Get the referral programme',
			description:
				'Returns the referral settings and every tier, disabled ones included. Requires REFERRAL_MANAGE permission.',
			responseSchema: AdminReferralResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const view = await ctx.get('referralAdminService').getAdminView();
			await recordAdminRead(ctx, {
				targetType: 'referral',
				targetId: 0n,
				action: AdminAuditReadActions.VIEW_REFERRAL,
				metadata: {result_count: view.tiers.length},
			});
			return ctx.json(view);
		},
	);
	app.patch(
		'/admin/referral/settings',
		RateLimitMiddleware(ReferralRateLimitConfigs.ADMIN_REFERRAL),
		requireAdminACL(AdminACLs.REFERRAL_MANAGE),
		Validator('json', UpdateReferralSettingsRequest),
		OpenAPI({
			operationId: 'update_admin_referral_settings',
			summary: 'Update referral settings',
			description:
				'Opens or closes the programme and sets the active days, the daily cap and the IP registration limit; an omitted field stays as it is. Closing stops new links and new referrals; pending ones are still decided and earned rewards stay. Requires REFERRAL_MANAGE permission.',
			responseSchema: AdminReferralResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {before, after} = await ctx.get('referralAdminService').updateSettings(ctx.req.valid('json'));
			await recordAdminWrite(ctx, {
				targetType: 'referral',
				targetId: 0n,
				action: 'update_referral_settings',
				metadata: describeChange(before, after.settings, SETTING_KEYS),
			});
			return ctx.json(after);
		},
	);
	app.post(
		'/admin/referral/tiers',
		RateLimitMiddleware(ReferralRateLimitConfigs.ADMIN_REFERRAL),
		requireAdminACL(AdminACLs.REFERRAL_MANAGE),
		Validator('json', CreateReferralTierRequest),
		OpenAPI({
			operationId: 'create_admin_referral_tier',
			summary: 'Create a referral tier',
			description:
				'Adds a tier, at most 50; a cosmetic reward must be an owned-availability item. Referrers already at the threshold receive it from a rate-limited background job. Requires REFERRAL_MANAGE permission.',
			responseSchema: ReferralTierResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const tier = await ctx.get('referralAdminService').createTier(ctx.req.valid('json'), ctx.get('adminUserId'));
			await recordAdminWrite(ctx, {
				targetType: 'referral_tier',
				targetId: BigInt(tier.id),
				action: 'create_referral_tier',
				metadata: {threshold: tier.threshold, reward_type: tier.reward.type, enabled: tier.enabled},
			});
			return ctx.json(tier);
		},
	);
	app.patch(
		'/admin/referral/tiers/:tier_id',
		RateLimitMiddleware(ReferralRateLimitConfigs.ADMIN_REFERRAL),
		requireAdminACL(AdminACLs.REFERRAL_MANAGE),
		Validator('param', ReferralTierIdParam),
		Validator('json', UpdateReferralTierRequest),
		OpenAPI({
			operationId: 'update_admin_referral_tier',
			summary: 'Update a referral tier',
			description:
				'Changes the threshold or turns the tier on or off; the reward never changes. Lowering the threshold or turning the tier on grants it to referrers now at it; raising it or turning it off takes nothing back. Requires REFERRAL_MANAGE permission.',
			responseSchema: ReferralTierResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {tier_id} = ctx.req.valid('param');
			const {before, after} = await ctx
				.get('referralAdminService')
				.updateTier(tier_id, ctx.req.valid('json'), ctx.get('adminUserId'));
			await recordAdminWrite(ctx, {
				targetType: 'referral_tier',
				targetId: tier_id,
				action: 'update_referral_tier',
				metadata: describeChange(before, after, TIER_KEYS),
			});
			return ctx.json(after);
		},
	);
	app.get(
		'/admin/referral/pending-rewards',
		RateLimitMiddleware(ReferralRateLimitConfigs.ADMIN_REFERRAL),
		requireAdminACL(AdminACLs.REFERRAL_MANAGE),
		Validator('query', ListReferralPendingRewardsQuery),
		OpenAPI({
			operationId: 'list_admin_referral_pending_rewards',
			summary: 'List pending off-site referral rewards',
			description:
				'Returns one page of the off-site rewards granted in a UTC month that staff have not delivered yet, oldest first. Requires REFERRAL_MANAGE permission.',
			responseSchema: AdminReferralPendingRewardsResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {month, cursor, limit} = ctx.req.valid('query');
			const page = await ctx
				.get('referralAdminService')
				.listPendingRewards(month ?? new Date().toISOString().slice(0, 7), cursor ?? null, limit);
			await recordAdminRead(ctx, {
				targetType: 'referral',
				targetId: 0n,
				action: AdminAuditReadActions.VIEW_REFERRAL_PENDING_REWARDS,
				metadata: {month: page.month, result_count: page.items.length},
			});
			return ctx.json(page);
		},
	);
	app.get(
		'/admin/users/:user_id/referrals',
		RateLimitMiddleware(ReferralRateLimitConfigs.ADMIN_REFERRAL),
		requireAdminACL(AdminACLs.REFERRAL_MANAGE),
		Validator('param', UserIdParam),
		Validator('query', ListUserReferralsQuery),
		OpenAPI({
			operationId: 'get_admin_user_referrals',
			summary: 'Get the referrals of a user',
			description:
				'Returns the referral code, referrer, counts and rewards of an account and one page of the accounts it referred. Never returns an IP address or an off-site code. Requires REFERRAL_MANAGE permission.',
			responseSchema: AdminUserReferralsResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id} = ctx.req.valid('param');
			const {cursor, limit} = ctx.req.valid('query');
			const view = await ctx.get('referralAdminService').getUserReferrals(createUserID(user_id), cursor ?? null, limit);
			await recordAdminRead(ctx, {
				targetType: 'user',
				targetId: user_id,
				action: AdminAuditReadActions.VIEW_USER_REFERRALS,
				metadata: {result_count: view.referees.length},
			});
			return ctx.json(view);
		},
	);
	app.post(
		'/admin/users/:user_id/referral-rewards/:tier_id/deliver',
		RateLimitMiddleware(ReferralRateLimitConfigs.ADMIN_REFERRAL),
		requireAdminACL(AdminACLs.REFERRAL_MANAGE),
		Validator('param', AdminReferralRewardParam),
		Validator('json', DeliverReferralRewardRequest),
		OpenAPI({
			operationId: 'deliver_admin_referral_reward',
			summary: 'Deliver an off-site referral reward',
			description:
				'Marks a pending off-site reward delivered, optionally with a code only the referrer sees in their settings. The referrer gets a system DM and an email that never contain the code. Requires REFERRAL_MANAGE permission.',
			responseSchema: AdminReferralRewardResponse,
			statusCode: 200,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id, tier_id} = ctx.req.valid('param');
			const request = ctx.req.valid('json');
			const result = await ctx
				.get('referralAdminService')
				.deliver(createUserID(user_id), tier_id, request, ctx.get('adminUserId'));
			// whether a code was given, never the code.
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: user_id,
				action: 'deliver_referral_reward',
				metadata: {tier_id, has_code: result.has_code, note: request.note},
			});
			return ctx.json(result);
		},
	);
	app.post(
		'/admin/users/:user_id/referral-rewards/:tier_id/notify',
		RateLimitMiddleware(ReferralRateLimitConfigs.ADMIN_REFERRAL),
		requireAdminACL(AdminACLs.REFERRAL_MANAGE),
		Validator('param', AdminReferralRewardParam),
		Validator('json', NotifyReferralRewardRequest),
		OpenAPI({
			operationId: 'notify_admin_referral_reward',
			summary: 'Message a referrer about a pending reward',
			description:
				'Sends the referrer a system DM about a pending off-site reward, which stays pending. Text containing the stored code is refused. Requires REFERRAL_MANAGE permission.',
			responseSchema: null,
			statusCode: 204,
			security: 'adminApiKey',
			tags: 'Admin',
		}),
		async (ctx) => {
			const {user_id, tier_id} = ctx.req.valid('param');
			const {content} = ctx.req.valid('json');
			await ctx.get('referralAdminService').notify(createUserID(user_id), tier_id, content);
			await recordAdminWrite(ctx, {
				targetType: 'user',
				targetId: user_id,
				action: 'notify_referral_reward',
				metadata: {tier_id, content_length: content.length},
			});
			return ctx.body(null, 204);
		},
	);
}
