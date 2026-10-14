// SPDX-License-Identifier: AGPL-3.0-or-later

import {ReferralTierReward} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import {Int32Type, SnowflakeStringType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const ReferralTierResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the referral tier'),
	threshold: Int32Type.describe('Valid referrals needed'),
	reward: ReferralTierReward,
	enabled: z.boolean(),
});

export type ReferralTierResponse = z.infer<typeof ReferralTierResponse>;

export const ReferralRewardStatus = z.enum(['granting', 'auto_delivered', 'pending_admin', 'delivered']);

export type ReferralRewardStatus = z.infer<typeof ReferralRewardStatus>;

export const ReferralRejectReason = z.enum([
	'same_ip',
	'ip_velocity',
	'same_email',
	'risk',
	'unverified',
	'inactive',
	'account_gone',
]);

export type ReferralRejectReason = z.infer<typeof ReferralRejectReason>;

export const ReferralCounts = z.object({
	pending: Int32Type,
	valid: Int32Type,
	rejected: Int32Type,
});

export type ReferralCounts = z.infer<typeof ReferralCounts>;

export const ReferralMeResponse = z.object({
	enabled: z.boolean().describe('Whether the referral programme is open'),
	code: z.string().nullable().describe('Own referral code; null while the programme is closed'),
	counts: ReferralCounts,
	min_active_days: Int32Type.describe('Days a referred account must stay active to count'),
	tiers: z
		.array(z.object({id: SnowflakeStringType, threshold: Int32Type, reward: ReferralTierReward}))
		.describe('Enabled tiers by ascending threshold'),
	rewards: z.array(
		z.object({
			tier_id: SnowflakeStringType,
			reward: ReferralTierReward,
			status: ReferralRewardStatus,
			granted_at: z.iso.datetime(),
			delivered_at: z.iso.datetime().nullable(),
			code: z.string().nullable().describe('Off-site code, only when staff delivered one'),
		}),
	),
});

export type ReferralMeResponse = z.infer<typeof ReferralMeResponse>;

export const AdminReferralSettings = z.object({
	enabled: z.boolean(),
	min_active_days: Int32Type,
	daily_valid_cap: Int32Type,
	ip_registration_limit: Int32Type,
});

export type AdminReferralSettings = z.infer<typeof AdminReferralSettings>;

export const AdminReferralResponse = z.object({
	settings: AdminReferralSettings,
	tiers: z.array(ReferralTierResponse).describe('Every tier, disabled ones included'),
});

export type AdminReferralResponse = z.infer<typeof AdminReferralResponse>;

export const AdminReferralPendingRewardsResponse = z.object({
	month: z.string().describe('UTC month YYYY-MM'),
	items: z.array(
		z.object({
			user_id: SnowflakeStringType,
			tier_id: SnowflakeStringType,
			reward: ReferralTierReward,
			created_at: z.iso.datetime(),
		}),
	),
	next_cursor: z.string().nullable(),
});

export type AdminReferralPendingRewardsResponse = z.infer<typeof AdminReferralPendingRewardsResponse>;

export const AdminUserReferralsResponse = z.object({
	user_id: SnowflakeStringType,
	code: z.string().nullable().describe('The referral code of the user'),
	referrer_id: SnowflakeStringType.nullable().describe('Who referred this user'),
	counts: ReferralCounts,
	rewards: z.array(
		z.object({
			tier_id: SnowflakeStringType,
			reward: ReferralTierReward,
			status: ReferralRewardStatus,
			granted_at: z.iso.datetime(),
			delivered_at: z.iso.datetime().nullable(),
			delivered_by: SnowflakeStringType.nullable(),
			note: z.string().nullable(),
			has_code: z.boolean().describe('An off-site code was delivered; the code itself is never returned here'),
		}),
	),
	referees: z.array(
		z.object({
			referee_id: SnowflakeStringType,
			state: z.enum(['pending', 'valid', 'rejected']),
			reason: ReferralRejectReason.nullable(),
			referred_at: z.iso.datetime(),
		}),
	),
	next_cursor: z.string().nullable(),
});

export type AdminUserReferralsResponse = z.infer<typeof AdminUserReferralsResponse>;

export const AdminReferralRewardResponse = z.object({
	user_id: SnowflakeStringType,
	tier_id: SnowflakeStringType,
	status: ReferralRewardStatus,
	delivered_at: z.iso.datetime().nullable(),
	has_code: z.boolean(),
});

export type AdminReferralRewardResponse = z.infer<typeof AdminReferralRewardResponse>;
