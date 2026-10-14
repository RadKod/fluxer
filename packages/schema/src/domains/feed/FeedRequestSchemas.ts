// SPDX-License-Identifier: AGPL-3.0-or-later

import {ClientUploadedAttachmentRequest} from '@fluxer/schema/src/domains/message/AttachmentSchemas';
import {PresignedAttachmentUploadRequestItem} from '@fluxer/schema/src/domains/message/AttachmentUploadSchemas';
import {ReportMessageRequest} from '@fluxer/schema/src/domains/report/ReportSchemas';
import {createQueryIntegerType} from '@fluxer/schema/src/primitives/QueryValidators';
import {
	createStringType,
	NonNegativeSafeIntegerType,
	SnowflakeType,
} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

const FEED_POST_MAX_MEDIA = 4;

export const FeedPostIdParam = z.object({
	post_id: SnowflakeType.describe('The ID of the post'),
});

export type FeedPostIdParam = z.infer<typeof FeedPostIdParam>;

export const FeedPostIdCommentIdParam = FeedPostIdParam.extend({
	comment_id: SnowflakeType.describe('The ID of the comment'),
});

export type FeedPostIdCommentIdParam = z.infer<typeof FeedPostIdCommentIdParam>;

export const FeedPostIdCommentIdReplyIdParam = FeedPostIdCommentIdParam.extend({
	reply_id: SnowflakeType.describe('The ID of the reply'),
});

export type FeedPostIdCommentIdReplyIdParam = z.infer<typeof FeedPostIdCommentIdReplyIdParam>;

export const FEED_VIDEO_MAX_BYTES = 524_288_000;

export const FEED_VIDEO_CONTENT_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'] as const;

// Bunny Stream GUIDs key the video rows and KV entries in lowercase, so an upper case GUID reads the same video.
const FeedVideoGuidType = z.uuid().toLowerCase();

export const FeedVideoIdParam = z.object({
	video_id: FeedVideoGuidType.describe('The ID (Bunny Stream GUID) of the video'),
});

export type FeedVideoIdParam = z.infer<typeof FeedVideoIdParam>;

export const FeedVideoCreateRequest = z.object({
	filename: createStringType(1, 255).describe('Name of the file being uploaded'),
	file_size: z
		.number()
		.int()
		.min(1)
		.max(FEED_VIDEO_MAX_BYTES)
		.describe('Size of the file in bytes (at most 500 MB); the stored original is checked again after encoding'),
	content_type: z.enum(FEED_VIDEO_CONTENT_TYPES).describe('MIME type of the file'),
	content: createStringType(1, 2000)
		.nullish()
		.describe('Plain text of the post the video becomes once it passes processing (1-2000 characters)'),
	public: z.boolean().optional().describe('Ignored; the server sets the public bit from the author profile visibility'),
});

export type FeedVideoCreateRequest = z.infer<typeof FeedVideoCreateRequest>;

export const FeedVideoWebhookBody = z.object({
	VideoLibraryId: z.number().int().describe('The Bunny Stream library the video belongs to'),
	VideoGuid: FeedVideoGuidType.describe('The GUID of the video'),
	Status: z.number().int().describe('The Bunny Stream video status; unknown values are acknowledged and ignored'),
});

export type FeedVideoWebhookBody = z.infer<typeof FeedVideoWebhookBody>;

export const FeedAttachmentUploadRequest = z.object({
	attachments: z
		.array(PresignedAttachmentUploadRequestItem)
		.min(1)
		.max(FEED_POST_MAX_MEDIA)
		.describe('Images to upload for one post (1-4); a video post starts at POST /feed/videos'),
});

export type FeedAttachmentUploadRequest = z.infer<typeof FeedAttachmentUploadRequest>;

export const FEED_POLL_MAX_OPTIONS = 4;

export const FeedPollCreateRequest = z.object({
	options: z
		.array(createStringType(1, 80))
		.min(2)
		.max(FEED_POLL_MAX_OPTIONS)
		.describe('The choices, 2-4, each 1-80 characters; one vote per account, not changeable'),
	duration_hours: z.number().int().min(1).max(168).describe('Hours the poll takes votes (1-168)'),
});

export type FeedPollCreateRequest = z.infer<typeof FeedPollCreateRequest>;

export const FeedPostCreateRequest = z.object({
	content: createStringType(1, 2000).nullish().describe('Plain text of the post (1-2000 characters)'),
	attachments: z
		.array(ClientUploadedAttachmentRequest)
		.max(FEED_POST_MAX_MEDIA)
		.optional()
		.describe('Images uploaded through POST /feed/attachments (at most 4); a post needs text or media'),
	public: z.boolean().optional().describe('Ignored; the server sets the public bit from the author profile visibility'),
	poll: FeedPollCreateRequest.optional().describe('A poll; needs text as the question and no attachments'),
});

export type FeedPostCreateRequest = z.infer<typeof FeedPostCreateRequest>;

export const FeedPageQuery = z.object({
	before: SnowflakeType.optional().describe('Return posts older than this post ID'),
	limit: createQueryIntegerType({defaultValue: 25, minValue: 1, maxValue: 50}).describe(
		'Maximum number of posts to return (1-50)',
	),
});

export type FeedPageQuery = z.infer<typeof FeedPageQuery>;

export const FeedDiscoverQuery = z.object({
	cursor: z
		.string()
		.regex(/^\d{1,16}\.\d{1,5}$/)
		.optional()
		.describe('The X-Next-Cursor value of the previous page'),
	limit: createQueryIntegerType({defaultValue: 20, minValue: 1, maxValue: 50}).describe('Posts to return (1-50)'),
});

export type FeedDiscoverQuery = z.infer<typeof FeedDiscoverQuery>;

export const FeedPollVoteRequest = z.object({
	option: z
		.number()
		.int()
		.min(0)
		.max(FEED_POLL_MAX_OPTIONS - 1)
		.describe('Index of the chosen option'),
});

export type FeedPollVoteRequest = z.infer<typeof FeedPollVoteRequest>;

export const FeedViewsRequest = z.object({
	views: z
		.array(
			z.object({
				id: SnowflakeType.describe('The ID of a post the caller saw'),
				token: z.string().min(1).max(64).describe('The view_token that came with the post'),
			}),
		)
		.min(1)
		.max(100)
		.describe('Posts seen since the last batch, at most 100'),
});

export type FeedViewsRequest = z.infer<typeof FeedViewsRequest>;

export const FeedCommentsQuery = z.object({
	before: SnowflakeType.optional().describe('Return comments older than this comment ID'),
	limit: createQueryIntegerType({defaultValue: 25, minValue: 1, maxValue: 50}).describe(
		'Maximum number of comments to return (1-50)',
	),
});

export type FeedCommentsQuery = z.infer<typeof FeedCommentsQuery>;

export const FeedLikersQuery = z.object({
	after: SnowflakeType.optional().describe('Return accounts with IDs above this user ID'),
	limit: createQueryIntegerType({defaultValue: 50, minValue: 1, maxValue: 100}).describe(
		'Maximum number of accounts to return (1-100)',
	),
});

export type FeedLikersQuery = z.infer<typeof FeedLikersQuery>;

export const FeedNotificationsQuery = z.object({
	before: SnowflakeType.optional().describe('Return notifications older than this notification ID'),
	limit: createQueryIntegerType({defaultValue: 25, minValue: 1, maxValue: 50}).describe(
		'Maximum number of notifications to return (1-50)',
	),
});

export type FeedNotificationsQuery = z.infer<typeof FeedNotificationsQuery>;

export const FeedNotificationAckRequest = z.object({
	read_at: z.iso
		.datetime()
		.describe(
			'ISO8601 timestamp up to which the user has seen notifications; the server keeps the later of this and its cursor, never a future time',
		),
	unread_seq: NonNegativeSafeIntegerType.describe(
		'The newest unread sequence this session had seen (READY, pushes, acks); the read covers no more than this',
	),
	unread_epoch: NonNegativeSafeIntegerType.describe(
		'The unread epoch of that sequence; under another epoch the session saw none of the current sequence',
	),
});

export type FeedNotificationAckRequest = z.infer<typeof FeedNotificationAckRequest>;

export const FeedCommentCreateRequest = z.object({
	content: createStringType(1, 1000).describe('Plain text of the comment (1-1000 characters)'),
});

export type FeedCommentCreateRequest = z.infer<typeof FeedCommentCreateRequest>;

export const ReportFeedPostRequest = z.object({
	post_id: SnowflakeType.describe('ID of the post being reported'),
	category: ReportMessageRequest.shape.category,
});

export type ReportFeedPostRequest = z.infer<typeof ReportFeedPostRequest>;

export const ReportFeedCommentRequest = ReportFeedPostRequest.extend({
	comment_id: SnowflakeType.describe('ID of the comment being reported'),
	parent_comment_id: SnowflakeType.optional().describe(
		'ID of the top-level comment when the reported comment is a reply to it',
	),
});

export type ReportFeedCommentRequest = z.infer<typeof ReportFeedCommentRequest>;
