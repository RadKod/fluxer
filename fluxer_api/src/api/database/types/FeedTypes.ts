// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {MessageEmbed} from '@app/api/database/types/MessageTypes';

type Nullish<T> = T | null;

export interface FeedMedia {
	attachment_id: bigint;
	filename: string;
	size: bigint;
	description: Nullish<string>;
	width: Nullish<number>;
	height: Nullish<number>;
	content_type: string;
	content_hash: Nullish<string>;
	placeholder: Nullish<string>;
	flags: number;
	nsfw: Nullish<boolean>;
	duration?: Nullish<number>;
	// A Bunny Stream video: its GUID and the play_<res>.mp4 file the post plays; the media has no CDN object of its own.
	stream_video_id?: Nullish<string>;
	stream_mp4_file?: Nullish<string>;
}

export interface FeedPostRow {
	post_id: bigint;
	author_id: UserID;
	content: Nullish<string>;
	media: Nullish<Array<FeedMedia>>;
	edited_at: Nullish<Date>;
	flags: number;
	like_count?: Nullish<number>;
	comment_count?: Nullish<number>;
	poll_options?: Nullish<Array<string>>;
	poll_expires_at?: Nullish<Date>;
	poll_vote_count_0?: Nullish<number>;
	poll_vote_count_1?: Nullish<number>;
	poll_vote_count_2?: Nullish<number>;
	poll_vote_count_3?: Nullish<number>;
	embeds?: Nullish<Array<MessageEmbed>>;
	// Base of the view counter (KV counter flush); the driver reads bigint as BigInt.
	view_count?: Nullish<bigint>;
}

// The only feed_posts.flags bits. PUBLIC: the author let the post reach accounts outside the profile rule (Keşfet, the
// post and its comments); a post created without the field stays 0 (no consent from old clients).
export const FeedPostFlags = {PUBLIC: 1 << 0} as const;

export function isPublicFeedPost(post: Pick<FeedPostRow, 'flags'>): boolean {
	return (post.flags & FeedPostFlags.PUBLIC) !== 0;
}

export interface FeedPostByAuthorRow {
	author_id: UserID;
	bucket: number;
	post_id: bigint;
}

export interface FeedAuthorBucketRow {
	author_id: UserID;
	bucket: number;
	updated_at: Date;
}

export interface FeedHomeRow {
	user_id: UserID;
	day: number;
	post_id: bigint;
	author_id: UserID;
}

export interface FeedLikeByUserRow {
	user_id: UserID;
	day: number;
	post_id: bigint;
	liked_at: Date;
}

export interface FeedPostLikeRow {
	post_id: bigint;
	shard: number;
	user_id: UserID;
	liked_at: Date;
}

export interface FeedCommentRow {
	post_id: bigint;
	bucket: number;
	comment_id: bigint;
	author_id: UserID;
	content: string;
	edited_at: Nullish<Date>;
	reply_count?: Nullish<number>;
}

export interface FeedCommentByAuthorRow {
	author_id: UserID;
	bucket: number;
	comment_id: bigint;
	post_id: bigint;
	// Set for a reply: the top-level comment it answers (the reply row sits in feed_comment_replies under it).
	parent_id?: Nullish<bigint>;
}

export interface FeedCommentReplyRow {
	post_id: bigint;
	comment_id: bigint;
	bucket: number;
	reply_id: bigint;
	author_id: UserID;
	content: string;
	edited_at: Nullish<Date>;
}

export interface FeedCommentReplyBucketRow {
	post_id: bigint;
	comment_id: bigint;
	bucket: number;
	updated_at: Date;
}

export interface FeedCommentBucketRow {
	post_id: bigint;
	bucket: number;
	updated_at: Date;
}

export interface FeedNotificationRow {
	user_id: UserID;
	bucket: number;
	notification_id: bigint;
	notification_type: string;
	post_id: Nullish<bigint>;
	comment_id: Nullish<bigint>;
	actor_ids: Nullish<Array<UserID>>;
	actor_count: number;
	updated_at: Date;
}

// The feed inbox read cursor: a time, since a folded notification keeps its ID and moves updated_at.
export interface FeedNotificationReadStateRow {
	user_id: UserID;
	last_read_at: Date;
}

export type FeedVideoState = 'uploading' | 'processing' | 'scanning' | 'published' | 'deleting';

// A feed video waiting for Bunny Stream and the scan; it becomes a post only when the scan passes (post_id is set then).
export interface FeedVideoRow {
	video_guid: string;
	author_id: UserID;
	created_id: bigint;
	state: FeedVideoState;
	content: Nullish<string>;
	flags: number;
	content_type: string;
	declared_size: bigint;
	post_id: Nullish<bigint>;
	uploaded_at: Nullish<string>;
	original_hash: Nullish<string>;
	width: Nullish<number>;
	height: Nullish<number>;
	duration: Nullish<number>;
	mp4_file: Nullish<string>;
	scan_started_at: Nullish<Date>;
	updated_at: Date;
}

export interface FeedVideoByAuthorRow {
	author_id: UserID;
	created_id: bigint;
	video_guid: string;
}

export interface FeedVideoPendingRow {
	hour: number;
	shard: number;
	video_guid: string;
}

export interface FeedPollVoteRow {
	post_id: bigint;
	shard: number;
	user_id: UserID;
	option_index: number;
	voted_at: Date;
}

export interface FeedPollVoteByUserRow {
	user_id: UserID;
	day: number;
	post_id: bigint;
	option_index: number;
	voted_at: Date;
}

export const FEED_POST_COLUMNS = [
	'post_id',
	'author_id',
	'content',
	'media',
	'edited_at',
	'flags',
	'like_count',
	'comment_count',
	'poll_options',
	'poll_expires_at',
	'poll_vote_count_0',
	'poll_vote_count_1',
	'poll_vote_count_2',
	'poll_vote_count_3',
	'embeds',
	'view_count',
] as const satisfies ReadonlyArray<keyof FeedPostRow>;

export const FEED_POLL_VOTE_COUNT_COLUMNS = [
	'poll_vote_count_0',
	'poll_vote_count_1',
	'poll_vote_count_2',
	'poll_vote_count_3',
] as const satisfies ReadonlyArray<keyof FeedPostRow>;

export const FEED_POST_BY_AUTHOR_COLUMNS = ['author_id', 'bucket', 'post_id'] as const satisfies ReadonlyArray<
	keyof FeedPostByAuthorRow
>;

export const FEED_AUTHOR_BUCKET_COLUMNS = ['author_id', 'bucket', 'updated_at'] as const satisfies ReadonlyArray<
	keyof FeedAuthorBucketRow
>;

export const FEED_HOME_COLUMNS = ['user_id', 'day', 'post_id', 'author_id'] as const satisfies ReadonlyArray<
	keyof FeedHomeRow
>;

export const FEED_LIKE_BY_USER_COLUMNS = ['user_id', 'day', 'post_id', 'liked_at'] as const satisfies ReadonlyArray<
	keyof FeedLikeByUserRow
>;

export const FEED_POST_LIKE_COLUMNS = ['post_id', 'shard', 'user_id', 'liked_at'] as const satisfies ReadonlyArray<
	keyof FeedPostLikeRow
>;

export const FEED_COMMENT_COLUMNS = [
	'post_id',
	'bucket',
	'comment_id',
	'author_id',
	'content',
	'edited_at',
	'reply_count',
] as const satisfies ReadonlyArray<keyof FeedCommentRow>;

export const FEED_COMMENT_BY_AUTHOR_COLUMNS = [
	'author_id',
	'bucket',
	'comment_id',
	'post_id',
	'parent_id',
] as const satisfies ReadonlyArray<keyof FeedCommentByAuthorRow>;

export const FEED_COMMENT_REPLY_COLUMNS = [
	'post_id',
	'comment_id',
	'bucket',
	'reply_id',
	'author_id',
	'content',
	'edited_at',
] as const satisfies ReadonlyArray<keyof FeedCommentReplyRow>;

export const FEED_COMMENT_REPLY_BUCKET_COLUMNS = [
	'post_id',
	'comment_id',
	'bucket',
	'updated_at',
] as const satisfies ReadonlyArray<keyof FeedCommentReplyBucketRow>;

export const FEED_COMMENT_BUCKET_COLUMNS = ['post_id', 'bucket', 'updated_at'] as const satisfies ReadonlyArray<
	keyof FeedCommentBucketRow
>;

export const FEED_NOTIFICATION_COLUMNS = [
	'user_id',
	'bucket',
	'notification_id',
	'notification_type',
	'post_id',
	'comment_id',
	'actor_ids',
	'actor_count',
	'updated_at',
] as const satisfies ReadonlyArray<keyof FeedNotificationRow>;

export const FEED_NOTIFICATION_READ_STATE_COLUMNS = ['user_id', 'last_read_at'] as const satisfies ReadonlyArray<
	keyof FeedNotificationReadStateRow
>;

export const FEED_POLL_VOTE_COLUMNS = [
	'post_id',
	'shard',
	'user_id',
	'option_index',
	'voted_at',
] as const satisfies ReadonlyArray<keyof FeedPollVoteRow>;

export const FEED_POLL_VOTE_BY_USER_COLUMNS = [
	'user_id',
	'day',
	'post_id',
	'option_index',
	'voted_at',
] as const satisfies ReadonlyArray<keyof FeedPollVoteByUserRow>;

export const FEED_VIDEO_COLUMNS = [
	'video_guid',
	'author_id',
	'created_id',
	'state',
	'content',
	'flags',
	'content_type',
	'declared_size',
	'post_id',
	'uploaded_at',
	'original_hash',
	'width',
	'height',
	'duration',
	'mp4_file',
	'scan_started_at',
	'updated_at',
] as const satisfies ReadonlyArray<keyof FeedVideoRow>;

export const FEED_VIDEO_BY_AUTHOR_COLUMNS = ['author_id', 'created_id', 'video_guid'] as const satisfies ReadonlyArray<
	keyof FeedVideoByAuthorRow
>;

export const FEED_VIDEO_PENDING_COLUMNS = ['hour', 'shard', 'video_guid'] as const satisfies ReadonlyArray<
	keyof FeedVideoPendingRow
>;
