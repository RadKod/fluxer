// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {MS_PER_DAY} from '@fluxer/date_utils/src/DateConstants';
import type {
	ReferralRejectReason,
	ReferralRewardStatus,
} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';

type Nullish<T> = T | null;

export type ReferralState = 'pending' | 'valid' | 'rejected';

export interface ReferralCodeRow {
	code: string;
	user_id: UserID;
	created_at: Date;
}

// One row per account: its own code, and who referred it.
export interface UserReferralRow {
	user_id: UserID;
	code: Nullish<string>;
	referrer_id: Nullish<UserID>;
	referred_at: Nullish<Date>;
	state: Nullish<ReferralState>;
	reason: Nullish<ReferralRejectReason>;
	risk_blocked: Nullish<boolean>;
	decided_at: Nullish<Date>;
}

export interface ReferralByReferrerRow {
	referrer_id: UserID;
	bucket: number;
	referee_id: UserID;
	referred_at: Date;
	state: ReferralState;
	reason: Nullish<ReferralRejectReason>;
}

export interface ReferralBucketByReferrerRow {
	referrer_id: UserID;
	bucket: number;
}

// KVCounterService bases; only the counter flush writes them.
export interface ReferralStatsRow {
	user_id: UserID;
	valid_count: Nullish<bigint>;
	pending_count: Nullish<bigint>;
	rejected_count: Nullish<bigint>;
}

// The registration IP lives only here, under the row TTL, and goes with the row once decided (data retention).
export interface ReferralCheckRow {
	slot: number;
	shard: number;
	referee_id: UserID;
	due_at: Date;
	reg_ip: Nullish<string>;
}

export interface ReferralRewardRow {
	user_id: UserID;
	tier_id: bigint;
	reward: string; // ReferralTierReward as JSON, frozen when granted
	status: ReferralRewardStatus;
	granted_at: Date;
	delivered_at: Nullish<Date>;
	delivered_by: Nullish<UserID>;
	note: Nullish<string>;
	code: Nullish<string>; // off-site code: only the owner's GET /users/@me/referral and harvest ever return it
}

export interface ReferralPendingRewardRow {
	month: string;
	created_at: Date;
	user_id: UserID;
	tier_id: bigint;
}

export interface ReferrerByBandRow {
	band: number;
	shard: number;
	user_id: UserID;
}

// TEMPORARY: 1 hour slots read by a once-a-minute cron over 16 shards. Trigger: a slot
// partition passes 50 000 rows or the cursor lags more than 15 minutes. Path: 64 shards for new rows, the reader
// reading both layouts, like the shop checks.
export const REFERRAL_CHECK_SLOT_MS = 3_600_000;
export const REFERRAL_CHECK_SHARDS = 16;
// TEMPORARY: 64 shards per band. Trigger: one band partition passes 10^6 rows. Path: 256 shards under a new
// table name.
export const REFERRAL_BAND_SHARDS = 64;
// referralBand is floor(log2(n)) of a 32-bit count: the highest band any table read or delete walks to.
export const REFERRAL_MAX_BAND = 31;
// A referral still waiting N + 14 days after registration is rejected; its check row lives that
// long past its due time, so the rule and the row TTL come from this one number.
export const REFERRAL_DECISION_WINDOW_DAYS = 14;

export const REFERRAL_VALID_COUNTER = 'referral_valid';
export const REFERRAL_PENDING_COUNTER = 'referral_pending';
export const REFERRAL_REJECTED_COUNTER = 'referral_rejected';

export function referralCheckSlot(at: Date): number {
	return Math.floor(at.getTime() / REFERRAL_CHECK_SLOT_MS);
}

export function referralCheckShard(refereeId: bigint): number {
	return Number(refereeId % BigInt(REFERRAL_CHECK_SHARDS));
}

export function referralBandShard(userId: bigint): number {
	return Number(userId % BigInt(REFERRAL_BAND_SHARDS));
}

// floor(log2(n)), 0..REFERRAL_MAX_BAND.
export function referralBand(validCount: number): number {
	return validCount < 1 ? 0 : 31 - Math.clz32(validCount);
}

// TEMPORARY: one UTC day per referrer partition. Trigger: one day bucket passes 10^6 rows. Path: hour buckets.
export function referralDayBucket(at: Date): number {
	return Math.floor(at.getTime() / MS_PER_DAY);
}

// TEMPORARY: one partition per UTC month. Trigger: 10^5 pending rewards in a month. Path: (month, shard).
export function referralPendingMonth(at: Date): string {
	return at.toISOString().slice(0, 7);
}

export const REFERRAL_CODE_COLUMNS = ['code', 'user_id', 'created_at'] as const satisfies ReadonlyArray<
	keyof ReferralCodeRow
>;

export const USER_REFERRAL_COLUMNS = [
	'user_id',
	'code',
	'referrer_id',
	'referred_at',
	'state',
	'reason',
	'risk_blocked',
	'decided_at',
] as const satisfies ReadonlyArray<keyof UserReferralRow>;

export const REFERRAL_BY_REFERRER_COLUMNS = [
	'referrer_id',
	'bucket',
	'referee_id',
	'referred_at',
	'state',
	'reason',
] as const satisfies ReadonlyArray<keyof ReferralByReferrerRow>;

export const REFERRAL_BUCKET_BY_REFERRER_COLUMNS = ['referrer_id', 'bucket'] as const satisfies ReadonlyArray<
	keyof ReferralBucketByReferrerRow
>;

export const REFERRAL_STATS_COLUMNS = [
	'user_id',
	'valid_count',
	'pending_count',
	'rejected_count',
] as const satisfies ReadonlyArray<keyof ReferralStatsRow>;

export const REFERRAL_CHECK_COLUMNS = [
	'slot',
	'shard',
	'referee_id',
	'due_at',
	'reg_ip',
] as const satisfies ReadonlyArray<keyof ReferralCheckRow>;

export const REFERRAL_REWARD_COLUMNS = [
	'user_id',
	'tier_id',
	'reward',
	'status',
	'granted_at',
	'delivered_at',
	'delivered_by',
	'note',
	'code',
] as const satisfies ReadonlyArray<keyof ReferralRewardRow>;

export const REFERRAL_PENDING_REWARD_COLUMNS = [
	'month',
	'created_at',
	'user_id',
	'tier_id',
] as const satisfies ReadonlyArray<keyof ReferralPendingRewardRow>;

export const REFERRER_BY_BAND_COLUMNS = ['band', 'shard', 'user_id'] as const satisfies ReadonlyArray<
	keyof ReferrerByBandRow
>;
