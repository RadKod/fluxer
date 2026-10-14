// SPDX-License-Identifier: AGPL-3.0-or-later

import {DiscoveryGuildListResponse} from '@fluxer/schema/src/domains/guild/GuildDiscoverySchemas';
import {MessageEmbedResponse} from '@fluxer/schema/src/domains/message/EmbedSchemas';
import {MessageAttachmentResponse} from '@fluxer/schema/src/domains/message/MessageResponseSchemas';
import {UserPartialResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';
import {
	createNamedStringLiteralUnion,
	Int32Type,
	NonNegativeSafeIntegerType,
	SnowflakeStringType,
	withOpenApiType,
} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const FeedPollResponse = z.object({
	options: z.array(z.string()).describe('The choices, in order'),
	expires_at: z.string().describe('ISO8601 timestamp when voting ends'),
	votes: z
		.array(Int32Type)
		.nullable()
		.describe('Votes per option; null until the viewer votes, is the author or it ends'),
	voted: Int32Type.nullable().describe("The viewer's option, or null"),
});

export type FeedPollResponse = z.infer<typeof FeedPollResponse>;

export const FeedLinkPreviewKind = withOpenApiType(
	createNamedStringLiteralUnion(
		[
			['youtube', 'youtube', 'A YouTube video'],
			['twitch', 'twitch', 'A Twitch channel, video or clip'],
			['kick', 'kick', 'A Kick channel, video or clip'],
			['invite', 'invite', 'A sanalyer community invite'],
		],
		'The kind of link a feed post previews',
	),
	'FeedLinkPreviewKind',
);

export type FeedLinkPreviewKind = z.infer<typeof FeedLinkPreviewKind>;

export const FeedLinkPreviewResponse = z.object({
	kind: FeedLinkPreviewKind,
	url: z.url().describe('The link as written in the post; the preview opens this URL'),
	invite_code: z.string().nullable().describe('The invite code for invite previews'),
	embed: MessageEmbedResponse.nullable().describe('The unfurled card, media through the media proxy; null for invites'),
});

export type FeedLinkPreviewResponse = z.infer<typeof FeedLinkPreviewResponse>;

export const FeedVideoResponse = z.object({
	id: z.string().describe('The ID (Bunny Stream GUID) of the video'),
	width: Int32Type.nullable().describe('Width in pixels'),
	height: Int32Type.nullable().describe('Height in pixels'),
	duration: Int32Type.nullable().describe('Length in seconds'),
	poster_url: z.url().describe('Signed URL of the poster image'),
	hls_url: z.url().describe('Signed URL of the HLS playlist'),
	mp4_url: z.url().nullable().describe('Signed URL of the MP4 file for players without HLS'),
	expires_at: z.string().describe('ISO8601 timestamp until which the signed URLs work; fetch the post again after it'),
});

export type FeedVideoResponse = z.infer<typeof FeedVideoResponse>;

export const FeedPostResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the post; its snowflake time is when it was posted'),
	author: UserPartialResponse.describe('The author of the post'),
	content: z.string().nullable().describe('The plain text of the post'),
	attachments: z
		.array(MessageAttachmentResponse)
		.describe('Images (at most 4) attached to the post; a video is in the video field'),
	edited_at: z.string().nullable().describe('ISO8601 timestamp of the last edit'),
	like_count: Int32Type.describe('Number of likes'),
	comment_count: Int32Type.describe('Number of comments'),
	liked: z.boolean().describe('Whether the current user likes the post'),
	public: z.boolean().optional().describe('Whether the post can reach accounts outside the author profile rule'),
	poll: FeedPollResponse.optional().describe('The poll, when the post has one'),
	link_preview: FeedLinkPreviewResponse.optional().describe('The one previewed link, when the post has one'),
	video: FeedVideoResponse.optional().describe('The Bunny Stream video, when the post has one'),
	view_count: NonNegativeSafeIntegerType.optional().describe(
		'How many times the post was seen, a minute or two behind; absent while view counts are off',
	),
	view_token: z
		.string()
		.optional()
		.describe(
			'Signed ticket for POST /feed/views, for the caller and this post only, valid 12 hours; absent while view counts are off',
		),
	author_following: z
		.boolean()
		.optional()
		.describe("Whether the caller follows the author; only on Discover pages, never on the caller's own posts"),
});

export type FeedPostResponse = z.infer<typeof FeedPostResponse>;

export const FeedPostListResponse = z.array(FeedPostResponse).describe('One page of posts, newest first');

export type FeedPostListResponse = z.infer<typeof FeedPostListResponse>;

export const FeedVideoUploadResponse = z.object({
	id: z.string().describe('The ID (Bunny Stream GUID) of the video'),
	library_id: z.string().describe('The Bunny Stream library the TUS upload names'),
	upload: z
		.object({
			endpoint: z.url().describe('The TUS endpoint'),
			signature: z.string().describe('The AuthorizationSignature of the TUS upload'),
			expires: z.number().int().describe('The AuthorizationExpire of the TUS upload, in unix seconds'),
		})
		.describe('What the client needs to upload the file with TUS'),
});

export type FeedVideoUploadResponse = z.infer<typeof FeedVideoUploadResponse>;

export const FeedPendingVideoState = withOpenApiType(
	createNamedStringLiteralUnion(
		[
			['uploading', 'uploading', 'The file is being uploaded'],
			['processing', 'processing', 'Bunny Stream is encoding the video'],
			['scanning', 'scanning', 'The video is being checked before it is posted'],
			['published', 'published', 'The video is posted'],
		],
		'Where a feed video is on its way to becoming a post',
	),
	'FeedPendingVideoState',
);

export type FeedPendingVideoState = z.infer<typeof FeedPendingVideoState>;

export const FeedPendingVideoResponse = z.object({
	id: z.string().describe('The ID (Bunny Stream GUID) of the video'),
	state: FeedPendingVideoState,
	created_at: z.string().describe('ISO8601 timestamp when the upload started'),
	post_id: SnowflakeStringType.nullable().describe('The post, once the video is published'),
});

export type FeedPendingVideoResponse = z.infer<typeof FeedPendingVideoResponse>;

export const FeedPendingVideoListResponse = z
	.array(FeedPendingVideoResponse)
	.describe("The author's videos that are not posts yet or were posted in the last hours, newest first");

export type FeedPendingVideoListResponse = z.infer<typeof FeedPendingVideoListResponse>;

export const FeedCommentResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the comment'),
	post_id: SnowflakeStringType.describe('The post the comment belongs to'),
	author: UserPartialResponse.describe('The author of the comment'),
	content: z.string().describe('The plain text of the comment'),
	edited_at: z.string().nullable().describe('ISO8601 timestamp of the last edit'),
	parent_id: SnowflakeStringType.nullable()
		.optional()
		.describe('The top-level comment this reply answers; absent or null for a top-level comment'),
	reply_count: Int32Type.optional().describe('Number of replies to a top-level comment'),
});

export type FeedCommentResponse = z.infer<typeof FeedCommentResponse>;

export const FeedCommentListResponse = z.array(FeedCommentResponse).describe('One page of comments, newest first');

export type FeedCommentListResponse = z.infer<typeof FeedCommentListResponse>;

export const FeedPostLikersResponse = z
	.array(UserPartialResponse)
	.describe('One page of accounts that like the post, by ascending user ID');

export type FeedPostLikersResponse = z.infer<typeof FeedPostLikersResponse>;

export const FeedNotificationType = withOpenApiType(
	createNamedStringLiteralUnion(
		[
			['post_like', 'post_like', 'Accounts liked a post of yours'],
			['post_comment', 'post_comment', 'Accounts commented on a post of yours'],
			['follow', 'follow', 'Accounts started following you'],
			['comment_reply', 'comment_reply', 'Accounts replied to a comment of yours'],
		],
		'The kind of feed notification',
	),
	'FeedNotificationType',
);

export type FeedNotificationType = z.infer<typeof FeedNotificationType>;

export const FeedNotificationResponse = z.object({
	id: SnowflakeStringType.describe('The ID of the notification'),
	type: FeedNotificationType,
	post_id: SnowflakeStringType.nullable().describe('The post it is about, or null for follows'),
	comment_id: SnowflakeStringType.nullable().describe('The comment it is about, when there is one'),
	actors: z.array(UserPartialResponse).max(3).describe('Up to three of the accounts behind the notification'),
	actor_count: Int32Type.describe('How many accounts are behind the notification'),
	updated_at: z.string().describe('ISO8601 timestamp of the latest action folded into it'),
});

export type FeedNotificationResponse = z.infer<typeof FeedNotificationResponse>;

export const FeedNotificationListResponse = z
	.array(FeedNotificationResponse)
	.describe('One page of notifications, newest first');

export type FeedNotificationListResponse = z.infer<typeof FeedNotificationListResponse>;

// The badge shows 1-9 and "9+", so READY counts at most this many unread notifications.
export const FEED_NOTIFICATION_UNREAD_CAP = 10;

// The unread state expires after a quiet day and its sequence starts again from 0; a new epoch says so.
export const FeedNotificationUnreadEpoch = NonNegativeSafeIntegerType.describe(
	'When the unread sequence began (Unix ms), 0 before it exists; a later epoch means the sequence started again from 0',
);

export const FeedNotificationStateResponse = z.object({
	last_read_at: z
		.string()
		.nullable()
		.describe(
			'ISO8601 timestamp up to which the current user has read their notifications, or null before the first read',
		),
	unread_count: Int32Type.max(FEED_NOTIFICATION_UNREAD_CAP).describe(
		'Notifications updated after last_read_at, counted up to 10 over the newest 20 days',
	),
	unread_seq: NonNegativeSafeIntegerType.describe(
		'The unread sequence this count includes; FEED_NOTIFICATION_CREATE carries newer values',
	),
	unread_epoch: FeedNotificationUnreadEpoch,
});

export type FeedNotificationStateResponse = z.infer<typeof FeedNotificationStateResponse>;

export const FeedNotificationAckResponse = z.object({
	last_read_at: z.string().describe('ISO8601 timestamp of the read cursor after the request'),
	unread_seq: NonNegativeSafeIntegerType.describe(
		'The unread sequence the read covers; notifications counted after it stay unread',
	),
	unread_epoch: FeedNotificationUnreadEpoch,
});

export type FeedNotificationAckResponse = z.infer<typeof FeedNotificationAckResponse>;

// The FEED_NOTIFICATION_CREATE payload: the notification and the recipient's unread sequence after it.
export const FeedNotificationCreateEvent = FeedNotificationResponse.extend({
	unread_seq: NonNegativeSafeIntegerType.describe(
		"The recipient's unread sequence after this notification; the rise since the last value seen is the number of newly unread notifications",
	),
	unread_epoch: FeedNotificationUnreadEpoch,
});

export type FeedNotificationCreateEvent = z.infer<typeof FeedNotificationCreateEvent>;

// Micup akis-oneri: the Discovery guild object, taken from the list schema so the upstream file stays untouched.
const FeedSuggestedGuildResponse = DiscoveryGuildListResponse.shape.guilds.element;

export const FeedSuggestionsResponse = z.object({
	users: z
		.array(UserPartialResponse)
		.max(5)
		.describe(
			'Up to five popular accounts to follow, picked at random from the top 100 by followers each time; never the caller, an account the caller follows or one that blocks the caller either way. Empty for a caller who may not follow strangers yet, or who is not an adult by their date of birth (none counts as not an adult)',
		),
	guilds: z
		.array(FeedSuggestedGuildResponse)
		.max(5)
		.describe(
			'Up to five popular Discovery communities the caller is not in, picked at random from the top 100 by members',
		),
});

export type FeedSuggestionsResponse = z.infer<typeof FeedSuggestionsResponse>;
