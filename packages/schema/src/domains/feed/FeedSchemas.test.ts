// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	FEED_VIDEO_CONTENT_TYPES,
	FEED_VIDEO_MAX_BYTES,
	FeedDiscoverQuery,
	FeedNotificationAckRequest,
	FeedPollVoteRequest,
	FeedPostCreateRequest,
	FeedVideoCreateRequest,
	FeedVideoIdParam,
	FeedVideoWebhookBody,
	FeedViewsRequest,
	ReportFeedCommentRequest,
} from '@fluxer/schema/src/domains/feed/FeedRequestSchemas';
import {
	FEED_NOTIFICATION_UNREAD_CAP,
	FeedCommentResponse,
	FeedNotificationAckResponse,
	FeedNotificationCreateEvent,
	FeedNotificationResponse,
	FeedNotificationStateResponse,
	FeedNotificationType,
	FeedPostResponse,
	FeedSuggestionsResponse,
} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {DiscoveryGuildListResponse} from '@fluxer/schema/src/domains/guild/GuildDiscoverySchemas';
import {describe, expect, it} from 'vitest';

const VIDEO = {filename: 'klip.mp4', content_type: 'video/mp4'};
const GUID = 'a1b2c3d4-e5f6-4a7b-8c9d-0123456789ab';
const COMMENT = {
	id: '2',
	post_id: '1',
	author: {
		id: '3',
		username: 'epha',
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	},
	content: 'selam',
	edited_at: null,
};
const POST = {
	id: '1',
	author: COMMENT.author,
	content: 'selam',
	attachments: [],
	edited_at: null,
	like_count: 0,
	comment_count: 0,
	liked: false,
};
const GUILD = {
	id: '5',
	name: 'Kahve',
	icon: null,
	banner: null,
	description: null,
	category_type: 0,
	primary_language: 'tr',
	custom_tags: [],
	member_count: 120,
	online_count: 8,
	features: [],
	verification_level: 0,
};
const suggestions = (users: number, guilds: number) => ({
	users: Array.from({length: users}, (_, index) => ({...COMMENT.author, id: String(index + 10)})),
	guilds: Array.from({length: guilds}, (_, index) => ({...GUILD, id: String(index + 20)})),
});
const views = (count: number, token = 'a.b') => ({
	views: Array.from({length: count}, (_, index) => ({id: String(index + 1), token})),
});

describe('feed request schemas', () => {
	it('leaves public out when the client does not send it', () => {
		expect(FeedPostCreateRequest.parse({content: 'selam'}).public).toBeUndefined();
	});
	it('accepts a poll of 2-4 options up to 80 characters and 1-168 hours', () => {
		expect(
			FeedPostCreateRequest.safeParse({content: 'q', poll: {options: ['a', 'b'], duration_hours: 1}}).success,
		).toBe(true);
		expect(FeedPostCreateRequest.safeParse({content: 'q', poll: {options: ['a'], duration_hours: 1}}).success).toBe(
			false,
		);
		expect(
			FeedPostCreateRequest.safeParse({content: 'q', poll: {options: ['a', 'b', 'c', 'd', 'e'], duration_hours: 1}})
				.success,
		).toBe(false);
		expect(
			FeedPostCreateRequest.safeParse({content: 'q', poll: {options: ['a', 'x'.repeat(81)], duration_hours: 1}})
				.success,
		).toBe(false);
		expect(
			FeedPostCreateRequest.safeParse({content: 'q', poll: {options: ['a', 'b'], duration_hours: 169}}).success,
		).toBe(false);
		expect(
			FeedPostCreateRequest.safeParse({content: 'q', poll: {options: ['a', 'b'], duration_hours: 0}}).success,
		).toBe(false);
	});
	it('takes a vote for options 0-3 only', () => {
		expect(FeedPollVoteRequest.safeParse({option: 3}).success).toBe(true);
		expect(FeedPollVoteRequest.safeParse({option: 4}).success).toBe(false);
		expect(FeedPollVoteRequest.safeParse({option: -1}).success).toBe(false);
	});
	it('reads a discover cursor as version.offset and pages 1-50, 20 by default', () => {
		expect(FeedDiscoverQuery.parse({})).toEqual({limit: 20});
		expect(FeedDiscoverQuery.safeParse({cursor: '1790000000000.40'}).success).toBe(true);
		expect(FeedDiscoverQuery.safeParse({cursor: '40'}).success).toBe(false);
		expect(FeedDiscoverQuery.safeParse({limit: '51'}).success).toBe(false);
	});
});

describe('feed video schemas', () => {
	it('accepts a 500 MB video create request and refuses one byte more', () => {
		expect(FEED_VIDEO_MAX_BYTES).toBe(524_288_000);
		expect(FeedVideoCreateRequest.safeParse({...VIDEO, file_size: 524_288_000}).success).toBe(true);
		expect(FeedVideoCreateRequest.safeParse({...VIDEO, file_size: 524_288_001}).success).toBe(false);
		expect(FeedVideoCreateRequest.safeParse({...VIDEO, file_size: 0}).success).toBe(false);
	});
	it('refuses a video content type outside the four', () => {
		expect(FEED_VIDEO_CONTENT_TYPES).toEqual(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska']);
		for (const content_type of FEED_VIDEO_CONTENT_TYPES) {
			expect(FeedVideoCreateRequest.safeParse({...VIDEO, content_type, file_size: 1}).success).toBe(true);
		}
		for (const content_type of ['video/x-msvideo', 'image/png', 'VIDEO/MP4']) {
			expect(FeedVideoCreateRequest.safeParse({...VIDEO, content_type, file_size: 1}).success).toBe(false);
		}
	});
	it('parses a Bunny webhook body with any integer status and refuses a non-uuid guid', () => {
		for (const Status of [0, 4, 99, -1]) {
			expect(FeedVideoWebhookBody.parse({VideoLibraryId: 761025, VideoGuid: GUID, Status})).toEqual({
				VideoLibraryId: 761025,
				VideoGuid: GUID,
				Status,
			});
		}
		expect(FeedVideoWebhookBody.safeParse({VideoLibraryId: 761025, VideoGuid: 'x', Status: 4}).success).toBe(false);
		expect(FeedVideoWebhookBody.safeParse({VideoLibraryId: 761025, VideoGuid: GUID, Status: 4.5}).success).toBe(false);
	});
	it('reads a video id as a lowercase uuid', () => {
		expect(FeedVideoIdParam.parse({video_id: GUID.toUpperCase()}).video_id).toBe(GUID);
		expect(FeedVideoIdParam.safeParse({video_id: `../${GUID}`}).success).toBe(false);
	});
});

describe('feed reply schemas', () => {
	it('keeps comment responses without parent_id valid', () => {
		expect(FeedCommentResponse.safeParse(COMMENT).success).toBe(true);
		expect(FeedCommentResponse.parse({...COMMENT, reply_count: 3}).reply_count).toBe(3);
		expect(FeedCommentResponse.parse({...COMMENT, id: '4', parent_id: '2'}).parent_id).toBe('2');
	});
	it('reports a reply with the comment it answers and names comment_reply notifications', () => {
		const report = {post_id: '1', comment_id: '4', category: 'spam'};
		expect(ReportFeedCommentRequest.parse({...report, parent_comment_id: '2'}).parent_comment_id).toBe(2n);
		expect(ReportFeedCommentRequest.parse(report).parent_comment_id).toBeUndefined();
		expect(FeedNotificationType.safeParse('comment_reply').success).toBe(true);
	});
});

describe('feed view schemas', () => {
	it('accepts a batch of 100 views and refuses 101 or none', () => {
		expect(FeedViewsRequest.parse(views(100)).views[99]).toEqual({id: 100n, token: 'a.b'});
		expect(FeedViewsRequest.safeParse(views(101)).success).toBe(false);
		expect(FeedViewsRequest.safeParse(views(0)).success).toBe(false);
		expect(FeedViewsRequest.safeParse({}).success).toBe(false);
	});
	it('refuses a view without a token or with a token over 64 characters', () => {
		expect(FeedViewsRequest.safeParse(views(1, 'x'.repeat(64))).success).toBe(true);
		expect(FeedViewsRequest.safeParse(views(1, 'x'.repeat(65))).success).toBe(false);
		expect(FeedViewsRequest.safeParse(views(1, '')).success).toBe(false);
		expect(FeedViewsRequest.safeParse({views: [{id: '1'}]}).success).toBe(false);
		expect(FeedViewsRequest.safeParse({views: [{id: 'x', token: 'a.b'}]}).success).toBe(false);
	});
	it('keeps post responses without view_count and view_token valid', () => {
		const parsed = FeedPostResponse.parse(POST);
		expect(parsed.view_count).toBeUndefined();
		expect(parsed.view_token).toBeUndefined();
		expect(FeedPostResponse.parse({...POST, view_count: 12, view_token: 'a.b'})).toMatchObject({
			view_count: 12,
			view_token: 'a.b',
		});
		expect(FeedPostResponse.safeParse({...POST, view_count: -1}).success).toBe(false);
	});
});

describe('feed follow schemas', () => {
	it('keeps post responses without author_following valid and takes a boolean', () => {
		expect(FeedPostResponse.parse(POST).author_following).toBeUndefined();
		expect(FeedPostResponse.parse({...POST, author_following: true}).author_following).toBe(true);
		expect(FeedPostResponse.parse({...POST, author_following: false}).author_following).toBe(false);
		expect(FeedPostResponse.safeParse({...POST, author_following: 'yes'}).success).toBe(false);
	});
});

describe('FeedSuggestionsResponse', () => {
	it('accepts up to five partial users and five Discovery guilds', () => {
		expect(FeedSuggestionsResponse.parse(suggestions(5, 5))).toEqual(suggestions(5, 5));
		expect(FeedSuggestionsResponse.parse(suggestions(0, 0))).toEqual({users: [], guilds: []});
	});
	it('refuses a sixth user or guild', () => {
		expect(FeedSuggestionsResponse.safeParse(suggestions(6, 5)).success).toBe(false);
		expect(FeedSuggestionsResponse.safeParse(suggestions(5, 6)).success).toBe(false);
	});
	it('keeps only the partial user fields (an email or phone never passes through)', () => {
		const user = {...COMMENT.author, email: 'a@b.co', phone: '+905550000000', follower_count: 9};
		expect(FeedSuggestionsResponse.parse({users: [user], guilds: []}).users).toEqual([COMMENT.author]);
	});
	it('takes the Discovery guild shape from the Discovery list schema', () => {
		expect(FeedSuggestionsResponse.shape.guilds.element).toBe(DiscoveryGuildListResponse.shape.guilds.element);
	});
});

describe('feed notification read state (2a.9b)', () => {
	it('takes an ISO read time and the sequence the session saw, nothing else', () => {
		const read_at = '2026-10-03T12:00:00.000Z';
		const unread_epoch = 1_759_492_800_000;
		expect(FeedNotificationAckRequest.safeParse({read_at, unread_seq: 3, unread_epoch}).success).toBe(true);
		expect(FeedNotificationAckRequest.safeParse({read_at, unread_epoch}).success).toBe(false);
		expect(FeedNotificationAckRequest.safeParse({read_at: '1759492800000', unread_seq: 3, unread_epoch}).success).toBe(
			false,
		);
		expect(FeedNotificationAckRequest.safeParse({read_at, unread_seq: -1, unread_epoch}).success).toBe(false);
	});

	it('caps the READY count at 10 and allows a null cursor', () => {
		const state = {last_read_at: null, unread_count: FEED_NOTIFICATION_UNREAD_CAP, unread_seq: 0, unread_epoch: 0};
		expect(FEED_NOTIFICATION_UNREAD_CAP).toBe(10);
		expect(FeedNotificationStateResponse.safeParse(state).success).toBe(true);
		expect(FeedNotificationStateResponse.safeParse({...state, unread_count: 11}).success).toBe(false);
		expect(FeedNotificationStateResponse.safeParse({...state, unread_count: -1}).success).toBe(false);
	});

	it('carries the unread sequence on FEED_NOTIFICATION_CREATE but not in the list', () => {
		const row = {
			id: '1',
			type: 'post_like',
			post_id: '2',
			comment_id: null,
			actors: [],
			actor_count: 1,
			updated_at: '2026-10-03T12:00:00.000Z',
		};
		expect(FeedNotificationCreateEvent.safeParse({...row, unread_seq: 3, unread_epoch: 5}).success).toBe(true);
		expect(FeedNotificationCreateEvent.safeParse(row).success).toBe(false);
		expect(Object.keys(FeedNotificationResponse.shape)).not.toContain('unread_seq');
	});

	// The unread hash can expire and start again from 0; the epoch tells a client its sequence restarted.
	it('carries the unread epoch with every unread sequence: READY, the ack and its answer, the push', () => {
		const read_at = '2026-10-03T12:00:00.000Z';
		expect(FeedNotificationAckRequest.safeParse({read_at, unread_seq: 3}).success).toBe(false);
		expect(FeedNotificationAckRequest.safeParse({read_at, unread_seq: 3, unread_epoch: -1}).success).toBe(false);
		expect(FeedNotificationAckResponse.safeParse({last_read_at: read_at, unread_seq: 3}).success).toBe(false);
		expect(FeedNotificationAckResponse.safeParse({last_read_at: read_at, unread_seq: 3, unread_epoch: 7}).success).toBe(
			true,
		);
		expect(FeedNotificationStateResponse.safeParse({last_read_at: null, unread_count: 0, unread_seq: 0}).success).toBe(
			false,
		);
		expect(FeedNotificationCreateEvent.shape.unread_epoch).toBeDefined();
	});
});
