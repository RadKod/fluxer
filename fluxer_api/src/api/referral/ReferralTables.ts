// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	REFERRAL_BUCKET_BY_REFERRER_COLUMNS,
	REFERRAL_BY_REFERRER_COLUMNS,
	REFERRAL_CHECK_COLUMNS,
	REFERRAL_CODE_COLUMNS,
	REFERRAL_PENDING_REWARD_COLUMNS,
	REFERRAL_REWARD_COLUMNS,
	REFERRAL_STATS_COLUMNS,
	REFERRER_BY_BAND_COLUMNS,
	type ReferralBucketByReferrerRow,
	type ReferralByReferrerRow,
	type ReferralCheckRow,
	type ReferralCodeRow,
	type ReferralPendingRewardRow,
	type ReferralRewardRow,
	type ReferralStatsRow,
	type ReferrerByBandRow,
	USER_REFERRAL_COLUMNS,
	type UserReferralRow,
} from '@app/api/database/types/ReferralTypes';

// Claimed with insertIfNotExists, so two accounts never share a code.
export const ReferralCodes = defineTable<ReferralCodeRow, 'code'>({
	name: 'referral_codes',
	columns: REFERRAL_CODE_COLUMNS,
	primaryKey: ['code'],
});
export const UserReferrals = defineTable<UserReferralRow, 'user_id'>({
	name: 'user_referral',
	columns: USER_REFERRAL_COLUMNS,
	primaryKey: ['user_id'],
});
// Bucketed by referred_at UTC day like user_followers (GEÇİCİ: see referralDayBucket).
export const ReferralsByReferrer = defineTable<
	ReferralByReferrerRow,
	'referrer_id' | 'bucket' | 'referee_id',
	'referrer_id' | 'bucket'
>({
	name: 'referrals_by_referrer',
	columns: REFERRAL_BY_REFERRER_COLUMNS,
	primaryKey: ['referrer_id', 'bucket', 'referee_id'],
	partitionKey: ['referrer_id', 'bucket'],
});
export const ReferralBucketsByReferrer = defineTable<
	ReferralBucketByReferrerRow,
	'referrer_id' | 'bucket',
	'referrer_id'
>({
	name: 'referral_buckets_by_referrer',
	columns: REFERRAL_BUCKET_BY_REFERRER_COLUMNS,
	primaryKey: ['referrer_id', 'bucket'],
	partitionKey: ['referrer_id'],
});
export const ReferralStats = defineTable<ReferralStatsRow, 'user_id'>({
	name: 'referral_stats',
	columns: REFERRAL_STATS_COLUMNS,
	primaryKey: ['user_id'],
});
// The evaluation schedule: rows carry a row TTL (insertWithTtl, due_at + 14 days) and are deleted once evaluated.
export const ReferralChecks = defineTable<ReferralCheckRow, 'slot' | 'shard' | 'referee_id', 'slot' | 'shard'>({
	name: 'referral_checks',
	columns: REFERRAL_CHECK_COLUMNS,
	primaryKey: ['slot', 'shard', 'referee_id'],
	partitionKey: ['slot', 'shard'],
});
// Bounded by the tier count (at most 50).
export const ReferralRewards = defineTable<ReferralRewardRow, 'user_id' | 'tier_id', 'user_id'>({
	name: 'referral_rewards',
	columns: REFERRAL_REWARD_COLUMNS,
	primaryKey: ['user_id', 'tier_id'],
	partitionKey: ['user_id'],
});
// Off-site rewards waiting for staff, by UTC month (GEÇİCİ: see referralPendingMonth); deleted once delivered.
export const ReferralPendingRewards = defineTable<
	ReferralPendingRewardRow,
	'month' | 'created_at' | 'user_id' | 'tier_id',
	'month'
>({
	name: 'referral_pending_rewards',
	columns: REFERRAL_PENDING_REWARD_COLUMNS,
	primaryKey: ['month', 'created_at', 'user_id', 'tier_id'],
	partitionKey: ['month'],
});
// Referrers by floor(log2(valid count)) for tier backfill (GEÇİCİ: see REFERRAL_BAND_SHARDS).
export const ReferrersByBand = defineTable<ReferrerByBandRow, 'band' | 'shard' | 'user_id', 'band' | 'shard'>({
	name: 'referrers_by_band',
	columns: REFERRER_BY_BAND_COLUMNS,
	primaryKey: ['band', 'shard', 'user_id'],
	partitionKey: ['band', 'shard'],
});
