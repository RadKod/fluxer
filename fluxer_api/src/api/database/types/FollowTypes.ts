// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';

type Nullish<T> = T | null;

export interface UserFollowingRow {
	user_id: UserID;
	target_id: UserID;
	follow_id: bigint;
}

export interface UserFollowerRow {
	target_id: UserID;
	bucket: number;
	follow_id: bigint;
	user_id: UserID;
}

export interface UserFollowerBucketRow {
	target_id: UserID;
	bucket: number;
	updated_at: Date;
}

export interface UserFollowStatsRow {
	user_id: UserID;
	follower_count: Nullish<number>;
	following_count: Nullish<number>;
}

export const USER_FOLLOWING_COLUMNS = ['user_id', 'target_id', 'follow_id'] as const satisfies ReadonlyArray<
	keyof UserFollowingRow
>;

export const USER_FOLLOWER_COLUMNS = ['target_id', 'bucket', 'follow_id', 'user_id'] as const satisfies ReadonlyArray<
	keyof UserFollowerRow
>;

export const USER_FOLLOWER_BUCKET_COLUMNS = ['target_id', 'bucket', 'updated_at'] as const satisfies ReadonlyArray<
	keyof UserFollowerBucketRow
>;

export const USER_FOLLOW_STATS_COLUMNS = [
	'user_id',
	'follower_count',
	'following_count',
] as const satisfies ReadonlyArray<keyof UserFollowStatsRow>;
