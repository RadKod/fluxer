// SPDX-License-Identifier: AGPL-3.0-or-later

import {createQueryIntegerType} from '@fluxer/schema/src/primitives/QueryValidators';
import {createStringType, SnowflakeStringType, SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const ReferralTierReward = z
	.discriminatedUnion('type', [
		z.object({
			type: z.literal('cosmetic'),
			item_id: SnowflakeStringType.describe('An owned-availability cosmetic item'),
		}),
		z.object({
			type: z.literal('premium_days'),
			days: z.number().int().min(1).max(3650).describe('Premium days granted (1-3650)'),
		}),
		z.object({
			type: z.literal('offsite'),
			description: createStringType(1, 200).describe('What staff hand over by hand (1-200 characters)'),
		}),
	])
	.describe('What a referral tier gives');

export type ReferralTierReward = z.infer<typeof ReferralTierReward>;

const ReferralThreshold = z
	.number()
	.int()
	.min(1)
	.max(1_000_000)
	.describe('Valid referrals needed for the tier (1-1000000)');

export const CreateReferralTierRequest = z.object({
	threshold: ReferralThreshold,
	reward: ReferralTierReward,
	enabled: z.boolean().default(true).describe('Disabled tiers grant nothing new'),
});

export type CreateReferralTierRequest = z.infer<typeof CreateReferralTierRequest>;

// A tier's reward never changes: a new reward is a new tier, the old one disabled.
export const UpdateReferralTierRequest = z
	.object({
		threshold: ReferralThreshold.optional(),
		enabled: z.boolean().optional(),
	})
	.refine((value) => Object.values(value).some((field) => field !== undefined), 'At least one field is required');

export type UpdateReferralTierRequest = z.infer<typeof UpdateReferralTierRequest>;

export const UpdateReferralSettingsRequest = z.object({
	enabled: z.boolean().optional().describe('Off hides links and stops counting; earned rewards stay'),
	min_active_days: z.number().int().min(1).max(30).optional().describe('Days a referred account must stay active'),
	daily_valid_cap: z
		.number()
		.int()
		.min(1)
		.max(10_000)
		.optional()
		.describe('Valid referrals counted per referrer per day'),
	ip_registration_limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Registrations from one IP in 30 days above which a referral is not counted'),
});

export type UpdateReferralSettingsRequest = z.infer<typeof UpdateReferralSettingsRequest>;

export const ReferralTierIdParam = z.object({
	tier_id: SnowflakeType.describe('The ID of the referral tier'),
});

export type ReferralTierIdParam = z.infer<typeof ReferralTierIdParam>;

export const AdminReferralRewardParam = z.object({
	user_id: SnowflakeType.describe('The referrer'),
	tier_id: SnowflakeType.describe('The ID of the referral tier'),
});

export type AdminReferralRewardParam = z.infer<typeof AdminReferralRewardParam>;

export const DeliverReferralRewardRequest = z.object({
	code: createStringType(1, 256)
		.nullish()
		.describe('Off-site code shown only to the referrer; never logged or audited'),
	note: createStringType(0, 500).nullish().describe('Staff note'),
});

export type DeliverReferralRewardRequest = z.infer<typeof DeliverReferralRewardRequest>;

export const NotifyReferralRewardRequest = z.object({
	content: createStringType(1, 2000).describe('System DM text; must not contain the stored code'),
});

export type NotifyReferralRewardRequest = z.infer<typeof NotifyReferralRewardRequest>;

const ReferralPageCursor = createStringType(1, 200).optional().describe('Opaque cursor from next_cursor');
const ReferralPageLimit = createQueryIntegerType({defaultValue: 50, minValue: 1, maxValue: 100}).describe(
	'Maximum number of entries to return (1-100)',
);

export const ListReferralPendingRewardsQuery = z.object({
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.optional()
		.describe('UTC month YYYY-MM; absent means the current month'),
	cursor: ReferralPageCursor,
	limit: ReferralPageLimit,
});

export type ListReferralPendingRewardsQuery = z.infer<typeof ListReferralPendingRewardsQuery>;

export const ListUserReferralsQuery = z.object({
	cursor: ReferralPageCursor,
	limit: ReferralPageLimit,
});

export type ListUserReferralsQuery = z.infer<typeof ListUserReferralsQuery>;
