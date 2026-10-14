// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	USER_FOLLOW_STATS_COLUMNS,
	USER_FOLLOWER_BUCKET_COLUMNS,
	USER_FOLLOWER_COLUMNS,
	USER_FOLLOWING_COLUMNS,
	type UserFollowerBucketRow,
	type UserFollowerRow,
	type UserFollowingRow,
	type UserFollowStatsRow,
} from '@app/api/database/types/FollowTypes';

// Bounded by the max_following limit (2000 by default).
export const UserFollowing = defineTable<UserFollowingRow, 'user_id' | 'target_id', 'user_id'>({
	name: 'user_following',
	columns: USER_FOLLOWING_COLUMNS,
	primaryKey: ['user_id', 'target_id'],
	partitionKey: ['user_id'],
});
// Followers are bucketed by follow_id day (makeBucket's snowflake time rule with a one day bucket, not its 10 days); a
// celebrity's current bucket is the hottest partition of the feature (about 30 MB for 10^6 follows in a day).
// Trigger: a daily bucket over 10^6 rows moves new buckets to one hour.
export const UserFollowers = defineTable<UserFollowerRow, 'target_id' | 'bucket' | 'follow_id', 'target_id' | 'bucket'>(
	{
		name: 'user_followers',
		columns: USER_FOLLOWER_COLUMNS,
		primaryKey: ['target_id', 'bucket', 'follow_id'],
		partitionKey: ['target_id', 'bucket'],
	},
);
export const UserFollowerBuckets = defineTable<UserFollowerBucketRow, 'target_id' | 'bucket', 'target_id'>({
	name: 'user_follower_buckets',
	columns: USER_FOLLOWER_BUCKET_COLUMNS,
	primaryKey: ['target_id', 'bucket'],
	partitionKey: ['target_id'],
});
// Base values for the KV counters (buffered KV counter pattern); the counter flush writes them.
export const UserFollowStats = defineTable<UserFollowStatsRow, 'user_id'>({
	name: 'user_follow_stats',
	columns: USER_FOLLOW_STATS_COLUMNS,
	primaryKey: ['user_id'],
});
