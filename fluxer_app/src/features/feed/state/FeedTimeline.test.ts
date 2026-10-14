// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedCommentResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));

const {
	default: FeedTimeline,
	DISCOVER_TIMELINE,
	HOME_TIMELINE,
	MAX_LOADED_FEED_POSTS,
	userTimelineKey,
} = await import('@app/features/feed/state/FeedTimeline');

function wirePost(id: number, authorId = '7'): FeedPostResponse {
	return {
		id: String(id),
		author: {
			id: authorId,
			username: `user${authorId}`,
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		content: `post ${id}`,
		attachments: [],
		edited_at: null,
		like_count: 0,
		comment_count: 0,
		liked: false,
	};
}

function wireComment(id: number, parentId?: string): FeedCommentResponse {
	return {
		id: String(id),
		post_id: '2',
		author: wirePost(0, '8').author,
		content: `comment ${id}`,
		edited_at: null,
		...(parentId ? {parent_id: parentId} : {}),
	};
}

// Newest first, like the server: ids count down from `start`.
function page(start: number, size = 25): Array<FeedPostResponse> {
	return Array.from({length: size}, (_, index) => wirePost(start - index));
}

const ids = (key: string) => FeedTimeline.getTimeline(key)?.posts.map((post) => post.id) ?? [];

describe('FeedTimeline', () => {
	beforeEach(() => {
		FeedTimeline.reset();
	});

	it(`keeps at most ${MAX_LOADED_FEED_POSTS} posts in memory and drops the newest pages first`, () => {
		expect(MAX_LOADED_FEED_POSTS).toBe(200);
		FeedTimeline.open(HOME_TIMELINE);
		for (let index = 0; index < 10; index += 1) {
			FeedTimeline.handleFetchSuccess(HOME_TIMELINE, page(100_000 - index * 25), false);
		}
		const timeline = FeedTimeline.getTimeline(HOME_TIMELINE)!;
		expect(timeline.posts).toHaveLength(200);
		expect(timeline.droppedCount).toBe(50);
		// The two newest pages went; the oldest loaded post stays as the cursor for the next page.
		expect(timeline.posts[0]!.id).toBe(String(100_000 - 50));
		expect(FeedTimeline.getCursor(HOME_TIMELINE)).toBe(String(100_000 - 249));
	});

	it('restarting replaces the posts with the newest page and clears the dropped count', () => {
		FeedTimeline.open(HOME_TIMELINE);
		for (let index = 0; index < 9; index += 1) {
			FeedTimeline.handleFetchSuccess(HOME_TIMELINE, page(100_000 - index * 25), false);
		}
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, page(200_000), true);
		const timeline = FeedTimeline.getTimeline(HOME_TIMELINE)!;
		expect(ids(HOME_TIMELINE)).toEqual(page(200_000).map((post) => post.id));
		expect(timeline.droppedCount).toBe(0);
		expect(timeline.hasMore).toBe(true);
		expect(timeline.fetchedAt).not.toBeNull();
	});

	it('stops paging at an empty page and never lists a post twice', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, page(1000, 3), false);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(998), wirePost(997)], false);
		expect(ids(HOME_TIMELINE)).toEqual(['1000', '999', '998', '997']);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [], false);
		expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.hasMore).toBe(false);
	});

	it('ends the discover list only when the server gives no cursor', () => {
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, page(1000, 20), true, '17.20');
		expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.hasMore).toBe(true);
		expect(FeedTimeline.getCursor(DISCOVER_TIMELINE)).toBe('17.20');
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, [], false, '17.40');
		expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.hasMore).toBe(true);
		expect(FeedTimeline.getCursor(DISCOVER_TIMELINE)).toBe('17.40');
		// A full page without a cursor is the last one; the cursor never falls back to the last post id.
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, page(900, 20), false);
		expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.hasMore).toBe(false);
		expect(FeedTimeline.getCursor(DISCOVER_TIMELINE)).toBeUndefined();
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, page(1000, 20), true);
		expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.hasMore).toBe(false);
		expect(FeedTimeline.getCursor(DISCOVER_TIMELINE)).toBeUndefined();
	});

	it('drops posts it already shows when a newer snapshot repeats them', () => {
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, [wirePost(50), wirePost(40), wirePost(30)], true, '1.3');
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, [wirePost(40), wirePost(30), wirePost(20)], false, '2.6');
		expect(ids(DISCOVER_TIMELINE)).toEqual(['50', '40', '30', '20']);
	});

	it('maps public, poll and link_preview from the wire and defaults them for old servers', () => {
		const preview = {kind: 'invite' as const, url: 'https://micup.gg/invite/abc', invite_code: 'abc', embed: null};
		const poll = {options: ['Tea', 'Coffee'], expires_at: '2026-10-01T00:00:00.000Z', votes: [3, 1], voted: 0};
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[
				{...wirePost(3), public: true, poll, link_preview: preview},
				wirePost(2),
				// A server may write the absent parts as null instead of leaving them out.
				{...wirePost(1), poll: null, link_preview: null} as unknown as FeedPostResponse,
			],
			false,
		);
		const [withAll, old, nulls] = FeedTimeline.getTimeline(HOME_TIMELINE)!.posts;
		expect(withAll).toMatchObject({
			isPublic: true,
			poll: {options: ['Tea', 'Coffee'], expiresAt: '2026-10-01T00:00:00.000Z', votes: [3, 1], voted: 0},
			linkPreview: preview,
		});
		expect(old).toMatchObject({isPublic: false, poll: null, linkPreview: null});
		expect(nulls).toMatchObject({isPublic: false, poll: null, linkPreview: null});
	});

	it('keeps view_count and view_token, and null when the server sends none', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(
			HOME_TIMELINE,
			[{...wirePost(3), view_count: 1234, view_token: '1790000000.abc'}, {...wirePost(2), view_count: 0}, wirePost(1)],
			false,
		);
		const [counted, zero, off] = FeedTimeline.getTimeline(HOME_TIMELINE)!.posts;
		expect(counted).toMatchObject({viewCount: 1234, viewToken: '1790000000.abc'});
		expect(zero).toMatchObject({viewCount: 0, viewToken: null});
		// View counts off on the server: neither field comes.
		expect(off).toMatchObject({viewCount: null, viewToken: null});
	});

	it('keeps author_following, and null when the server sends none', () => {
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.handleFetchSuccess(
			DISCOVER_TIMELINE,
			[{...wirePost(3), author_following: false}, {...wirePost(2, '8'), author_following: true}, wirePost(1, '9')],
			true,
			'1.3',
		);
		const [stranger, followed, own] = FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.posts;
		expect(stranger!.authorFollowing).toBe(false);
		expect(followed!.authorFollowing).toBe(true);
		// Your own post, and every post from a server before akis-takip or outside Discover.
		expect(own!.authorFollowing).toBeNull();
	});

	it('flips every card of the author together across timelines and leaves posts without the field', () => {
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.open(userTimelineKey('7'));
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(
			DISCOVER_TIMELINE,
			[
				{...wirePost(3), author_following: false},
				{...wirePost(2, '8'), author_following: false},
				{...wirePost(1), author_following: false},
			],
			true,
			'1.3',
		);
		FeedTimeline.handleFetchSuccess(userTimelineKey('7'), [{...wirePost(4), author_following: false}], true);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(5)], true);
		FeedTimeline.handleAuthorFollowing('7', true);
		const following = (key: string) =>
			FeedTimeline.getTimeline(key)!.posts.map((post) => [post.id, post.authorFollowing]);
		expect(following(DISCOVER_TIMELINE)).toEqual([
			['3', true],
			['2', false],
			['1', true],
		]);
		expect(following(userTimelineKey('7'))).toEqual([['4', true]]);
		expect(following(HOME_TIMELINE)).toEqual([['5', null]]);
	});

	it('handleAuthorFollowing is idempotent and says whether anything changed', () => {
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, [{...wirePost(3), author_following: false}], true, '1.1');
		const before = FeedTimeline.getTimeline(DISCOVER_TIMELINE);
		expect(FeedTimeline.handleAuthorFollowing('7', false)).toBe(false);
		expect(FeedTimeline.handleAuthorFollowing('8', true)).toBe(false);
		// Nothing changed, so the timeline object is the same one (no re-render).
		expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)).toBe(before);
		expect(FeedTimeline.handleAuthorFollowing('7', true)).toBe(true);
		expect(FeedTimeline.handleAuthorFollowing('7', true)).toBe(false);
		expect(FeedTimeline.getPost('3')!.authorFollowing).toBe(true);
		expect(FeedTimeline.handleAuthorFollowing('7', false)).toBe(true);
		expect(FeedTimeline.getPost('3')!.authorFollowing).toBe(false);
	});

	it('a reloaded copy of the post without author_following keeps the follow state', () => {
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, [{...wirePost(3), author_following: false}], true, '1.1');
		FeedTimeline.handleAuthorFollowing('7', true);
		// A poll vote or fresh video URLs bring the post back without the field (it is on Discover pages only).
		FeedTimeline.handlePostUpdated({...wirePost(3), like_count: 9});
		expect(FeedTimeline.getPost('3')).toMatchObject({likeCount: 9, authorFollowing: true});
		FeedTimeline.handlePostUpdated({...wirePost(3), author_following: false});
		expect(FeedTimeline.getPost('3')!.authorFollowing).toBe(false);
	});

	it('replaces a post everywhere when the server returns it updated', () => {
		const poll = {options: ['Tea', 'Coffee'], expires_at: '2026-10-01T00:00:00.000Z', votes: null, voted: null};
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.open(DISCOVER_TIMELINE);
		FeedTimeline.open(userTimelineKey('8'));
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(2), {...wirePost(1), poll}], false);
		FeedTimeline.handleFetchSuccess(DISCOVER_TIMELINE, [{...wirePost(1), poll}], true, '1.1');
		FeedTimeline.handlePostUpdated({...wirePost(1), like_count: 9, poll: {...poll, votes: [4, 2], voted: 1}});
		for (const key of [HOME_TIMELINE, DISCOVER_TIMELINE]) {
			expect(FeedTimeline.getTimeline(key)!.posts.find((entry) => entry.id === '1')).toMatchObject({
				likeCount: 9,
				poll: {votes: [4, 2], voted: 1},
			});
		}
		expect(ids(HOME_TIMELINE)).toEqual(['2', '1']);
		// Only replaced where it is shown, never added.
		expect(ids(userTimelineKey('8'))).toEqual([]);
	});

	it('shows a new post of yours at the top of the home feed and of your open posts list', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.open(userTimelineKey('7'));
		FeedTimeline.open(userTimelineKey('8'));
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, page(1000, 2), false);
		FeedTimeline.handlePostCreated(wirePost(2000, '7'));
		expect(ids(HOME_TIMELINE)).toEqual(['2000', '1000', '999']);
		expect(ids(userTimelineKey('7'))).toEqual(['2000']);
		expect(ids(userTimelineKey('8'))).toEqual([]);
	});

	it('removes a post from every timeline and drops its comment thread', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.open(userTimelineKey('7'));
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, page(1000, 2), false);
		FeedTimeline.handleFetchSuccess(userTimelineKey('7'), page(1000, 1), false);
		FeedTimeline.openThread('1000');
		FeedTimeline.handlePostRemoved('1000');
		expect(ids(HOME_TIMELINE)).toEqual(['999']);
		expect(ids(userTimelineKey('7'))).toEqual([]);
		expect(FeedTimeline.getThread('1000')).toBeNull();
	});

	it('keeps a timeline shown in two places until both close it', () => {
		FeedTimeline.open(userTimelineKey('7'));
		FeedTimeline.open(userTimelineKey('7'));
		FeedTimeline.handleFetchSuccess(userTimelineKey('7'), [wirePost(1000)], false);
		FeedTimeline.close(userTimelineKey('7'));
		expect(ids(userTimelineKey('7'))).toEqual(['1000']);
		FeedTimeline.close(userTimelineKey('7'));
		expect(FeedTimeline.getTimeline(userTimelineKey('7'))).toBeNull();
	});

	it('closing a timeline drops the comment threads of posts no other timeline shows', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.open(userTimelineKey('7'));
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(1000)], false);
		FeedTimeline.handleFetchSuccess(userTimelineKey('7'), [wirePost(1000), wirePost(900)], false);
		FeedTimeline.openThread('1000');
		FeedTimeline.openThread('900');
		FeedTimeline.close(userTimelineKey('7'));
		expect(FeedTimeline.getTimeline(userTimelineKey('7'))).toBeNull();
		expect(FeedTimeline.getThread('1000')).not.toBeNull();
		expect(FeedTimeline.getThread('900')).toBeNull();
	});

	it("keeps a post's video and a comment's reply count", () => {
		const video = {
			id: '4f5c2b8e-8a8e-4b53-9a3a-6f1d8b2c7e10',
			width: 1080,
			height: 1920,
			duration: 42,
			poster_url: 'https://vz.micup.test/4f5c/thumbnail.jpg?token=a',
			hls_url: 'https://vz.micup.test/4f5c/playlist.m3u8?token=a',
			mp4_url: null,
			expires_at: '2026-09-28T12:00:00.000Z',
		};
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [{...wirePost(2), video}, wirePost(1)], false);
		const [withVideo, plain] = FeedTimeline.getTimeline(HOME_TIMELINE)!.posts;
		expect(withVideo!.video).toEqual(video);
		expect(plain!.video).toBeNull();
		FeedTimeline.openThread('2');
		FeedTimeline.handleThreadSuccess('2', [
			{...wireComment(20), reply_count: 3, parent_id: null},
			// Servers before replies leave both out.
			wireComment(19),
		]);
		expect(FeedTimeline.getThread('2')!.comments).toMatchObject([
			{id: '20', replyCount: 3, parentId: null},
			{id: '19', replyCount: 0, parentId: null},
		]);
	});

	it("a reply raises the parent's reply count and the post's comment count", () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [{...wirePost(2), comment_count: 5}], false);
		FeedTimeline.openThread('2');
		FeedTimeline.handleThreadSuccess('2', [{...wireComment(20), reply_count: 1}]);
		FeedTimeline.openReplies('2', '20');
		FeedTimeline.handleRepliesSuccess('2', '20', [wireComment(21, '20')]);
		FeedTimeline.handleReplyCreated(wireComment(30, '20'));
		// The same reply coming back (the push after the POST answer) counts once.
		FeedTimeline.handleReplyCreated(wireComment(30, '20'));
		expect(FeedTimeline.getReplies('2', '20')!.comments.map((reply) => reply.id)).toEqual(['30', '21']);
		expect(FeedTimeline.getReplies('2', '20')!.comments[0]).toMatchObject({parentId: '20'});
		expect(FeedTimeline.getRepliesCursor('2', '20')).toBe('21');
		expect(FeedTimeline.getThread('2')!.comments[0]!.replyCount).toBe(2);
		expect(FeedTimeline.getPost('2')!.commentCount).toBe(6);
		FeedTimeline.handleReplyRemoved('2', '20', '30');
		expect(FeedTimeline.getReplies('2', '20')!.comments.map((reply) => reply.id)).toEqual(['21']);
		expect(FeedTimeline.getThread('2')!.comments[0]!.replyCount).toBe(1);
		expect(FeedTimeline.getPost('2')!.commentCount).toBe(5);
	});

	it('removing a comment lowers comment_count by 1 + its replies', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [{...wirePost(2), comment_count: 9}], false);
		FeedTimeline.openThread('2');
		FeedTimeline.handleThreadSuccess('2', [{...wireComment(20), reply_count: 4}, wireComment(19)]);
		FeedTimeline.openReplies('2', '20');
		FeedTimeline.handleCommentRemoved('2', '20');
		expect(FeedTimeline.getPost('2')!.commentCount).toBe(4);
		expect(FeedTimeline.getThread('2')!.comments.map((comment) => comment.id)).toEqual(['19']);
		expect(FeedTimeline.getReplies('2', '20')).toBeNull();
		// A comment that is not loaded counts as one without replies.
		FeedTimeline.handleCommentRemoved('2', '18');
		expect(FeedTimeline.getPost('2')!.commentCount).toBe(3);
	});

	// A double click on delete, or a 404 for a reply deleted meanwhile, removes it again.
	it('uncounts a removed reply once, and only a reply it shows', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [{...wirePost(2), comment_count: 5}], false);
		FeedTimeline.openThread('2');
		FeedTimeline.handleThreadSuccess('2', [{...wireComment(20), reply_count: 2}]);
		FeedTimeline.openReplies('2', '20');
		FeedTimeline.handleRepliesSuccess('2', '20', [wireComment(31, '20'), wireComment(30, '20')]);
		FeedTimeline.handleReplyRemoved('2', '20', '31');
		FeedTimeline.handleReplyRemoved('2', '20', '31');
		FeedTimeline.handleReplyRemoved('2', '20', '99');
		expect(FeedTimeline.getThread('2')!.comments[0]!.replyCount).toBe(1);
		expect(FeedTimeline.getPost('2')!.commentCount).toBe(4);
		expect(FeedTimeline.getReplies('2', '20')!.comments.map((reply) => reply.id)).toEqual(['30']);
	});

	it('reply threads page like comment threads and go with their post', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(2), wirePost(1)], false);
		FeedTimeline.openThread('2');
		FeedTimeline.openReplies('2', '20');
		FeedTimeline.openReplies('1', '10');
		FeedTimeline.handleRepliesPending('2', '20');
		expect(FeedTimeline.getReplies('2', '20')).toMatchObject({isLoading: true, failure: null});
		FeedTimeline.handleRepliesFailure('2', '20', 'error');
		expect(FeedTimeline.getReplies('2', '20')).toMatchObject({isLoading: false, failure: 'error', hasMore: true});
		FeedTimeline.handleRepliesRetry('2', '20');
		FeedTimeline.handleRepliesSuccess('2', '20', []);
		expect(FeedTimeline.getReplies('2', '20')).toMatchObject({failure: null, hasMore: false});
		FeedTimeline.closeReplies('2', '20');
		expect(FeedTimeline.getReplies('2', '20')).toBeNull();
		FeedTimeline.openReplies('2', '20');
		// Closing the comments of a post or losing the post drops its reply threads.
		FeedTimeline.closeThread('2');
		expect(FeedTimeline.getReplies('2', '20')).toBeNull();
		FeedTimeline.handlePostRemoved('1');
		expect(FeedTimeline.getReplies('1', '10')).toBeNull();
		FeedTimeline.openReplies('2', '20');
		FeedTimeline.close(HOME_TIMELINE);
		expect(FeedTimeline.getReplies('2', '20')).toBeNull();
	});

	it('a new session (maybe another account) empties every timeline and thread but keeps open views loadable', () => {
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(1000)], false);
		FeedTimeline.openThread('1000');
		FeedTimeline.handleGatewayReady();
		expect(FeedTimeline.getTimeline(HOME_TIMELINE)).toMatchObject({posts: [], fetchedAt: null, hasMore: true});
		expect(FeedTimeline.getThread('1000')).toBeNull();
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(2000)], true);
		expect(ids(HOME_TIMELINE)).toEqual(['2000']);
	});

	// The feed page keeps its lists for the way back from a post page; a modal showing the same list opens and closes it.
	it('keeps a held timeline loaded after the surfaces that open it close', () => {
		const key = userTimelineKey('1');
		FeedTimeline.hold(key);
		FeedTimeline.hold(key);
		FeedTimeline.handleFetchSuccess(key, [wirePost(5)], true);
		FeedTimeline.open(key);
		FeedTimeline.close(key);
		expect(ids(key)).toEqual(['5']);
		// Holding again after a reset (another account) loads it from nothing.
		FeedTimeline.reset();
		FeedTimeline.hold(key);
		expect(FeedTimeline.getTimeline(key)).toMatchObject({posts: [], fetchedAt: null});
	});

	// Signed video URLs last at least 2 hours (Yeni-1); a list older than an hour loads again before its posts are shown.
	it('counts a timeline stale until it loads and again once its posts are an hour old', () => {
		FeedTimeline.open(HOME_TIMELINE);
		expect(FeedTimeline.isStale(HOME_TIMELINE)).toBe(true);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(1)], true);
		expect(FeedTimeline.isStale(HOME_TIMELINE)).toBe(false);
		const loadedAt = FeedTimeline.getTimeline(HOME_TIMELINE)!.fetchedAt!;
		vi.spyOn(Date, 'now').mockReturnValue(loadedAt + 3_600_000);
		expect(FeedTimeline.isStale(HOME_TIMELINE)).toBe(false);
		vi.spyOn(Date, 'now').mockReturnValue(loadedAt + 3_600_000 + 1);
		expect(FeedTimeline.isStale(HOME_TIMELINE)).toBe(true);
		vi.restoreAllMocks();
	});
});
