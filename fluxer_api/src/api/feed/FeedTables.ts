// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	FEED_AUTHOR_BUCKET_COLUMNS,
	FEED_COMMENT_BUCKET_COLUMNS,
	FEED_COMMENT_BY_AUTHOR_COLUMNS,
	FEED_COMMENT_COLUMNS,
	FEED_COMMENT_REPLY_BUCKET_COLUMNS,
	FEED_COMMENT_REPLY_COLUMNS,
	FEED_HOME_COLUMNS,
	FEED_LIKE_BY_USER_COLUMNS,
	FEED_NOTIFICATION_COLUMNS,
	FEED_NOTIFICATION_READ_STATE_COLUMNS,
	FEED_POLL_VOTE_BY_USER_COLUMNS,
	FEED_POLL_VOTE_COLUMNS,
	FEED_POST_BY_AUTHOR_COLUMNS,
	FEED_POST_COLUMNS,
	FEED_POST_LIKE_COLUMNS,
	FEED_VIDEO_BY_AUTHOR_COLUMNS,
	FEED_VIDEO_COLUMNS,
	FEED_VIDEO_PENDING_COLUMNS,
	type FeedAuthorBucketRow,
	type FeedCommentBucketRow,
	type FeedCommentByAuthorRow,
	type FeedCommentReplyBucketRow,
	type FeedCommentReplyRow,
	type FeedCommentRow,
	type FeedHomeRow,
	type FeedLikeByUserRow,
	type FeedNotificationReadStateRow,
	type FeedNotificationRow,
	type FeedPollVoteByUserRow,
	type FeedPollVoteRow,
	type FeedPostByAuthorRow,
	type FeedPostLikeRow,
	type FeedPostRow,
	type FeedVideoByAuthorRow,
	type FeedVideoPendingRow,
	type FeedVideoRow,
} from '@app/api/database/types/FeedTypes';
import {seconds} from 'itty-time';

// like_count and comment_count are the base values of the KV counters (buffered KV counter pattern): the counter flush writes them
// here, so a page of posts reads its counts from the rows it already loads.
export const FeedPosts = defineTable<FeedPostRow, 'post_id'>({
	name: 'feed_posts',
	columns: FEED_POST_COLUMNS,
	primaryKey: ['post_id'],
});
// Bucketed by post_id time (makeBucket, 10 days); max_feed_posts_per_day bounds a bucket at 500 rows.
export const FeedPostsByAuthor = defineTable<
	FeedPostByAuthorRow,
	'author_id' | 'bucket' | 'post_id',
	'author_id' | 'bucket'
>({
	name: 'feed_posts_by_author',
	columns: FEED_POST_BY_AUTHOR_COLUMNS,
	primaryKey: ['author_id', 'bucket', 'post_id'],
	partitionKey: ['author_id', 'bucket'],
});
export const FeedAuthorBuckets = defineTable<FeedAuthorBucketRow, 'author_id' | 'bucket', 'author_id'>({
	name: 'feed_author_buckets',
	columns: FEED_AUTHOR_BUCKET_COLUMNS,
	primaryKey: ['author_id', 'bucket'],
	partitionKey: ['author_id'],
});
// One day per partition (2000 follows x 50 posts a day caps it at 10^5 rows), 30 day TTL, one day TWCS windows so a
// whole expired day drops as one SSTable. Written only by the fan-out worker and never deleted from (deleted and
// blocked posts are filtered on read), which is what makes the schema's one day gc_grace_seconds safe.
export const FeedHome = defineTable<FeedHomeRow, 'user_id' | 'day' | 'post_id', 'user_id' | 'day'>({
	name: 'feed_home',
	columns: FEED_HOME_COLUMNS,
	primaryKey: ['user_id', 'day', 'post_id'],
	partitionKey: ['user_id', 'day'],
	defaultTtlSeconds: seconds('30 days'),
});
// "Did I like it": day is the post's day (from post_id, the feed_home day unit), so the likes for a page of posts sit
// in 1-3 partitions. No TTL: a like on an old post stays as long as its feed_post_likes row; account deletion and the
// data export page this table by day.
export const FeedLikesByUser = defineTable<FeedLikeByUserRow, 'user_id' | 'day' | 'post_id', 'user_id' | 'day'>({
	name: 'feed_likes_by_user',
	columns: FEED_LIKE_BY_USER_COLUMNS,
	primaryKey: ['user_id', 'day', 'post_id'],
	partitionKey: ['user_id', 'day'],
});
// shard = user_id % 16 spreads a viral post's likes over 16 partitions.
export const FeedPostLikes = defineTable<FeedPostLikeRow, 'post_id' | 'shard' | 'user_id', 'post_id' | 'shard'>({
	name: 'feed_post_likes',
	columns: FEED_POST_LIKE_COLUMNS,
	primaryKey: ['post_id', 'shard', 'user_id'],
	partitionKey: ['post_id', 'shard'],
});
// shard = user_id % 16 spreads a viral poll's votes over 16 partitions, like feed_post_likes.
export const FeedPollVotes = defineTable<FeedPollVoteRow, 'post_id' | 'shard' | 'user_id', 'post_id' | 'shard'>({
	name: 'feed_poll_votes',
	columns: FEED_POLL_VOTE_COLUMNS,
	primaryKey: ['post_id', 'shard', 'user_id'],
	partitionKey: ['post_id', 'shard'],
});
// "Did I vote": day is the post's day, so the votes for a page of posts sit in 1-4 partitions (feed_likes_by_user).
export const FeedPollVotesByUser = defineTable<FeedPollVoteByUserRow, 'user_id' | 'day' | 'post_id', 'user_id' | 'day'>(
	{
		name: 'feed_poll_votes_by_user',
		columns: FEED_POLL_VOTE_BY_USER_COLUMNS,
		primaryKey: ['user_id', 'day', 'post_id'],
		partitionKey: ['user_id', 'day'],
	},
);
export const FeedComments = defineTable<FeedCommentRow, 'post_id' | 'bucket' | 'comment_id', 'post_id' | 'bucket'>({
	name: 'feed_comments',
	columns: FEED_COMMENT_COLUMNS,
	primaryKey: ['post_id', 'bucket', 'comment_id'],
	partitionKey: ['post_id', 'bucket'],
});
// A commenter's comments, for account deletion and the data export (feed_comments is keyed by post). Bucketed by
// comment_id time (makeBucket, 10 days); the feed:comment:create:daily rate limit bounds a bucket at 5000 rows, and the
// buckets of an account run from its creation, so no bucket list is needed.
export const FeedCommentsByAuthor = defineTable<
	FeedCommentByAuthorRow,
	'author_id' | 'bucket' | 'comment_id',
	'author_id' | 'bucket'
>({
	name: 'feed_comments_by_author',
	columns: FEED_COMMENT_BY_AUTHOR_COLUMNS,
	primaryKey: ['author_id', 'bucket', 'comment_id'],
	partitionKey: ['author_id', 'bucket'],
});
// Lists the comment buckets of a post so paging never walks empty ten day buckets back to the post's creation.
export const FeedCommentBuckets = defineTable<FeedCommentBucketRow, 'post_id' | 'bucket', 'post_id'>({
	name: 'feed_comment_buckets',
	columns: FEED_COMMENT_BUCKET_COLUMNS,
	primaryKey: ['post_id', 'bucket'],
	partitionKey: ['post_id'],
});
// One level of replies under a top-level comment, bucketed by reply_id time (makeBucket, 10 days); replies count
// against max_comments_per_post, so a comment's replies stay under 10,000 rows in all.
export const FeedCommentReplies = defineTable<
	FeedCommentReplyRow,
	'post_id' | 'comment_id' | 'bucket' | 'reply_id',
	'post_id' | 'comment_id' | 'bucket'
>({
	name: 'feed_comment_replies',
	columns: FEED_COMMENT_REPLY_COLUMNS,
	primaryKey: ['post_id', 'comment_id', 'bucket', 'reply_id'],
	partitionKey: ['post_id', 'comment_id', 'bucket'],
});
// The (comment, bucket) pairs of a post that hold replies, so a reply page and post deletion skip empty buckets; the
// comment cap bounds a post's partition at 10,000 rows.
export const FeedCommentReplyBuckets = defineTable<
	FeedCommentReplyBucketRow,
	'post_id' | 'comment_id' | 'bucket',
	'post_id'
>({
	name: 'feed_comment_reply_buckets',
	columns: FEED_COMMENT_REPLY_BUCKET_COLUMNS,
	primaryKey: ['post_id', 'comment_id', 'bucket'],
	partitionKey: ['post_id'],
});
export const FeedNotifications = defineTable<
	FeedNotificationRow,
	'user_id' | 'bucket' | 'notification_id',
	'user_id' | 'bucket'
>({
	name: 'feed_notifications',
	columns: FEED_NOTIFICATION_COLUMNS,
	primaryKey: ['user_id', 'bucket', 'notification_id'],
	partitionKey: ['user_id', 'bucket'],
	defaultTtlSeconds: seconds('90 days'),
});
// One row per account; the 90 day TTL matches the inbox.
export const FeedNotificationReadStates = defineTable<FeedNotificationReadStateRow, 'user_id'>({
	name: 'feed_notification_read_states',
	columns: FEED_NOTIFICATION_READ_STATE_COLUMNS,
	primaryKey: ['user_id'],
	defaultTtlSeconds: seconds('90 days'),
});
// Keyed by the Bunny GUID because the webhook carries nothing else. No TTL: a published video's row lives as long as its
// post (a late webhook for a re-uploaded video must still find it); deleting the video deletes the row.
export const FeedVideos = defineTable<FeedVideoRow, 'video_guid'>({
	name: 'feed_videos',
	columns: FEED_VIDEO_COLUMNS,
	primaryKey: ['video_guid'],
});
// The author's videos still in processing. No TTL: failed or cancelled rows go at once, published ones at the 9 or 72
// hour check; the daily post cap bounds a partition at max_feed_posts_per_day x 3 days of rows.
export const FeedVideosByAuthor = defineTable<FeedVideoByAuthorRow, 'author_id' | 'created_id', 'author_id'>({
	name: 'feed_videos_by_author',
	columns: FEED_VIDEO_BY_AUTHOR_COLUMNS,
	primaryKey: ['author_id', 'created_id'],
	partitionKey: ['author_id'],
});
// Unfinished videos and published ones awaiting their last check, by creation hour and shard (first two GUID bytes
// % 64) so reconciliation reads one bounded partition per job. GEÇİCİ: 64 shards fixed (~325 rows a partition at the
// target of 500 K videos a day); path: 256 shards from new hours on; trigger: a bucket job over 60 s or requeued more
// than 5 times, or tombstone warnings on this table.
export const FeedVideosPending = defineTable<FeedVideoPendingRow, 'hour' | 'shard' | 'video_guid', 'hour' | 'shard'>({
	name: 'feed_videos_pending',
	columns: FEED_VIDEO_PENDING_COLUMNS,
	primaryKey: ['hour', 'shard', 'video_guid'],
	partitionKey: ['hour', 'shard'],
	defaultTtlSeconds: seconds('4 days'),
});
