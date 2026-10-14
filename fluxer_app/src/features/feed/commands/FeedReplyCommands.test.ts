// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {FeedCommentResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {localInstanceDomain: 'fluxer.test'}}));
vi.mock('@app/features/app/utils/LimitResolverAdapter', () => ({LimitResolver: {resolve: () => 1000}}));
vi.mock('@app/features/devtools/state/DeveloperOptions', () => ({default: {}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/guild/state/Guilds', () => ({default: {}}));
vi.mock('@app/features/member/models/GuildMember', () => ({GuildMember: class {}}));
vi.mock('@app/features/member/state/GuildMembers', () => ({default: {}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn()},
}));

const {http} = await import('@app/features/platform/transport/RestTransport');
const FeedReplyCommands = await import('@app/features/feed/commands/FeedReplyCommands');
const {default: FeedTimeline, FEED_PAGE_SIZE, HOME_TIMELINE} = await import('@app/features/feed/state/FeedTimeline');

function wireUser(id: string) {
	return {
		id,
		username: `user${id}`,
		discriminator: '0001',
		global_name: null,
		avatar: null,
		avatar_color: null,
		flags: 0,
	};
}

const wirePost: FeedPostResponse = {
	id: '100',
	author: wireUser('7'),
	content: 'post',
	attachments: [],
	edited_at: null,
	like_count: 0,
	comment_count: 4,
	liked: false,
};

function wireComment(id: number, fields: Partial<FeedCommentResponse> = {}): FeedCommentResponse {
	return {id: String(id), post_id: '100', author: wireUser('8'), content: `comment ${id}`, edited_at: null, ...fields};
}

function wireReply(id: number): FeedCommentResponse {
	return wireComment(id, {parent_id: '200'});
}

function reply<T>(body: T): RestResponse<T> {
	return {ok: true, status: 200, statusText: '', headers: {}, body};
}

function refusal(method: 'GET' | 'POST' | 'DELETE', status: number, code?: string): HttpError {
	return new HttpError({method, path: '/feed', status, body: code ? {code, message: code} : undefined});
}

const comment = () => FeedTimeline.getThread('100')!.comments.find((entry) => entry.id === '200');
const replyIds = () => FeedTimeline.getReplies('100', '200')?.comments.map((entry) => entry.id);

describe('FeedReplyCommands', () => {
	beforeEach(() => {
		vi.mocked(http.get).mockReset();
		vi.mocked(http.post).mockReset();
		vi.mocked(http.delete).mockReset();
		FeedTimeline.reset();
		FeedTimeline.open(HOME_TIMELINE);
		FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost], false);
		FeedTimeline.openThread('100');
		FeedTimeline.handleThreadSuccess('100', [wireComment(200, {reply_count: 3})]);
	});

	it('continues an empty reply page from the raw server cursor', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce({...reply([]), headers: {'x-next-before': '302'}})
			.mockResolvedValueOnce(reply([wireReply(301)]));
		await FeedReplyCommands.openReplies('100', comment()!);
		expect(FeedTimeline.getReplies('100', '200')).toMatchObject({hasMore: true, isLoading: false});
		await FeedReplyCommands.loadReplies('100', '200');
		expect(http.get).toHaveBeenLastCalledWith(Endpoints.FEED_COMMENT_REPLIES('100', '200'), {
			query: {limit: FEED_PAGE_SIZE, before: '302'},
		});
		expect(replyIds()).toEqual(['301']);
	});

	it('opens the replies of a comment and pages them with the oldest loaded reply as the before cursor', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(reply([wireReply(303), wireReply(302)]))
			.mockResolvedValueOnce(reply([wireReply(301)]));

		await FeedReplyCommands.openReplies('100', comment()!);
		await FeedReplyCommands.loadReplies('100', '200');

		expect(vi.mocked(http.get).mock.calls).toEqual([
			[Endpoints.FEED_COMMENT_REPLIES('100', '200'), {query: {limit: FEED_PAGE_SIZE}}],
			[Endpoints.FEED_COMMENT_REPLIES('100', '200'), {query: {limit: FEED_PAGE_SIZE, before: '302'}}],
		]);
		expect(replyIds()).toEqual(['303', '302', '301']);
	});

	it('opens a comment without replies without asking the server', async () => {
		FeedTimeline.handleThreadRestart('100');
		FeedTimeline.handleThreadSuccess('100', [wireComment(200)]);

		await FeedReplyCommands.openReplies('100', comment()!);

		expect(http.get).not.toHaveBeenCalled();
		expect(FeedTimeline.getReplies('100', '200')).toMatchObject({comments: [], hasMore: false, isLoading: false});
	});

	it('keeps the replies already open when the comment is opened again', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(reply([wireReply(303)]));
		await FeedReplyCommands.openReplies('100', comment()!);

		await FeedReplyCommands.openReplies('100', comment()!);

		expect(http.get).toHaveBeenCalledTimes(1);
		expect(replyIds()).toEqual(['303']);
	});

	it('drops the comment when its replies are gone (404)', async () => {
		vi.mocked(http.get).mockRejectedValueOnce(refusal('GET', 404, APIErrorCodes.UNKNOWN_FEED_COMMENT));

		await FeedReplyCommands.openReplies('100', comment()!);

		expect(comment()).toBeUndefined();
		expect(FeedTimeline.getReplies('100', '200')).toBeNull();
		expect(FeedTimeline.getPost('100')!.commentCount).toBe(0);
	});

	it('drops the post when it is gone before its replies load (404)', async () => {
		vi.mocked(http.get).mockRejectedValueOnce(refusal('GET', 404, APIErrorCodes.UNKNOWN_FEED_POST));

		await FeedReplyCommands.openReplies('100', comment()!);

		expect(FeedTimeline.getPost('100')).toBeNull();
		expect(FeedTimeline.getThread('100')).toBeNull();
	});

	it('posts a reply to the comment and counts it on the comment and the post', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(reply([]));
		await FeedReplyCommands.openReplies('100', comment()!);
		// The route names the comment even if the answer leaves parent_id out.
		vi.mocked(http.post).mockResolvedValueOnce(reply(wireComment(304)));

		expect(await FeedReplyCommands.createReply('100', '200', '  @user8 same  ')).toBe('ok');

		expect(http.post).toHaveBeenCalledWith(Endpoints.FEED_COMMENT_REPLIES('100', '200'), {
			body: {content: '@user8 same'},
		});
		expect(replyIds()).toEqual(['304']);
		expect(comment()!.replyCount).toBe(4);
		expect(FeedTimeline.getPost('100')!.commentCount).toBe(5);
	});

	it('drops the comment when a reply finds it gone (404)', async () => {
		vi.mocked(http.post).mockRejectedValueOnce(refusal('POST', 404, APIErrorCodes.UNKNOWN_FEED_COMMENT));

		expect(await FeedReplyCommands.createReply('100', '200', 'same')).toBe('gone');

		expect(comment()).toBeUndefined();
		expect(FeedTimeline.getPost('100')!.commentCount).toBe(0);
	});

	it('drops the post when a reply finds it gone (404)', async () => {
		vi.mocked(http.post).mockRejectedValueOnce(refusal('POST', 404, APIErrorCodes.UNKNOWN_FEED_POST));

		expect(await FeedReplyCommands.createReply('100', '200', 'same')).toBe('gone');

		expect(FeedTimeline.getPost('100')).toBeNull();
		expect(FeedTimeline.getThread('100')).toBeNull();
	});

	it('refuses an empty reply before any request', async () => {
		expect(await FeedReplyCommands.createReply('100', '200', '   ')).toBe('invalid');
		expect(http.post).not.toHaveBeenCalled();
	});

	it('deletes a reply, also one already gone, and uncounts it', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(reply([wireReply(303), wireReply(302)]));
		await FeedReplyCommands.openReplies('100', comment()!);
		vi.mocked(http.delete).mockResolvedValueOnce(reply(undefined)).mockRejectedValueOnce(refusal('DELETE', 404));

		expect(await FeedReplyCommands.deleteReply('100', '200', '303')).toBe('ok');
		expect(await FeedReplyCommands.deleteReply('100', '200', '302')).toBe('ok');

		expect(vi.mocked(http.delete).mock.calls[0]).toEqual([Endpoints.FEED_COMMENT_REPLY('100', '200', '303')]);
		expect(replyIds()).toEqual([]);
		expect(comment()!.replyCount).toBe(1);
		expect(FeedTimeline.getPost('100')!.commentCount).toBe(2);
	});

	it('drops the post when deleting a reply finds the post gone (404)', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(reply([wireReply(303)]));
		await FeedReplyCommands.openReplies('100', comment()!);
		vi.mocked(http.delete).mockRejectedValueOnce(refusal('DELETE', 404, APIErrorCodes.UNKNOWN_FEED_POST));

		expect(await FeedReplyCommands.deleteReply('100', '200', '303')).toBe('ok');

		expect(FeedTimeline.getPost('100')).toBeNull();
		expect(FeedTimeline.getThread('100')).toBeNull();
	});

	it('keeps a reply the server refuses to delete (403)', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(reply([wireReply(303)]));
		await FeedReplyCommands.openReplies('100', comment()!);
		vi.mocked(http.delete).mockRejectedValueOnce(refusal('DELETE', 403));

		expect(await FeedReplyCommands.deleteReply('100', '200', '303')).toBe('forbidden');
		expect(replyIds()).toEqual(['303']);
	});

	it('reports a reply with its parent comment id', async () => {
		vi.mocked(http.post).mockResolvedValueOnce(reply(undefined));

		await FeedReplyCommands.reportReply('100', '200', '303', 'spam');

		expect(http.post).toHaveBeenCalledWith(Endpoints.REPORT_FEED_COMMENT, {
			body: {post_id: '100', comment_id: '303', parent_comment_id: '200', category: 'spam'},
		});
	});
});
