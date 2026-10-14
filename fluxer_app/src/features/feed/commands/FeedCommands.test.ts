// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {FeedCommentResponse, FeedPostResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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
const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const {
	default: FeedTimeline,
	DISCOVER_PAGE_SIZE,
	DISCOVER_TIMELINE,
	FEED_PAGE_SIZE,
	HOME_TIMELINE,
	userTimelineKey,
} = await import('@app/features/feed/state/FeedTimeline');

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

function wirePost(id: number, fields: Partial<FeedPostResponse> = {}): FeedPostResponse {
	return {
		id: String(id),
		author: wireUser('7'),
		content: `post ${id}`,
		attachments: [],
		edited_at: null,
		like_count: 0,
		comment_count: 0,
		liked: false,
		...fields,
	};
}

function wireComment(id: number, postId: string): FeedCommentResponse {
	return {id: String(id), post_id: postId, author: wireUser('8'), content: `comment ${id}`, edited_at: null};
}

function reply<T>(body: T, status = 200, headers: Record<string, string> = {}): RestResponse<T> {
	return {ok: status < 300, status, statusText: '', headers, body};
}

function refusal(method: 'GET' | 'PUT' | 'POST' | 'DELETE', status: number, code?: string): HttpError {
	return new HttpError({method, path: '/feed', status, body: code ? {code, message: code} : undefined});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return {promise, resolve, reject};
}

const post = (id: string) => FeedTimeline.getPost(id);

describe('FeedCommands', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	beforeEach(() => {
		vi.mocked(http.get).mockReset();
		vi.mocked(http.put).mockReset();
		vi.mocked(http.post).mockReset();
		vi.mocked(http.delete).mockReset();
		FeedTimeline.reset();
	});

	describe('timeline paging', () => {
		it('asks for the next page with the oldest loaded post as the before cursor', async () => {
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([wirePost(300), wirePost(299)]))
				.mockResolvedValueOnce(reply([wirePost(250)]))
				.mockResolvedValueOnce(reply([]));
			FeedTimeline.open(HOME_TIMELINE);

			await FeedCommands.loadNextPage(HOME_TIMELINE);
			await FeedCommands.loadNextPage(HOME_TIMELINE);
			await FeedCommands.loadNextPage(HOME_TIMELINE);
			await FeedCommands.loadNextPage(HOME_TIMELINE);

			expect(vi.mocked(http.get).mock.calls).toEqual([
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE}}],
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE, before: '299'}}],
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE, before: '250'}}],
			]);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.posts.map((entry) => entry.id)).toEqual(['300', '299', '250']);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.hasMore).toBe(false);
		});

		it('continues from X-Next-Before, past an empty page cut by the server read budget, 600 ms later', async () => {
			vi.useFakeTimers();
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([wirePost(300)], 200, {'x-next-before': '280'}))
				.mockResolvedValueOnce(reply([], 200, {'x-next-before': '150'}))
				.mockResolvedValueOnce(reply([wirePost(120)]))
				.mockResolvedValueOnce(reply([]));
			FeedTimeline.open(HOME_TIMELINE);

			await FeedCommands.loadNextPage(HOME_TIMELINE);
			const loading = FeedCommands.loadNextPage(HOME_TIMELINE);
			await vi.advanceTimersByTimeAsync(599);
			expect(http.get).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(1);
			await loading;
			await FeedCommands.loadNextPage(HOME_TIMELINE);

			expect(vi.mocked(http.get).mock.calls).toEqual([
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE}}],
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE, before: '280'}}],
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE, before: '150'}}],
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE, before: '120'}}],
			]);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.posts.map((entry) => entry.id)).toEqual(['300', '120']);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.hasMore).toBe(false);
		});

		it('the new posts button keeps going when the newest page is empty but has X-Next-Before', async () => {
			vi.useFakeTimers();
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([], 200, {'x-next-before': '500'}))
				.mockResolvedValueOnce(reply([wirePost(450)]));
			FeedTimeline.open(HOME_TIMELINE);

			const loading = FeedCommands.refresh(HOME_TIMELINE);
			await vi.advanceTimersByTimeAsync(600);
			await loading;

			expect(vi.mocked(http.get).mock.calls[1]).toEqual([
				Endpoints.FEED_HOME,
				{query: {limit: FEED_PAGE_SIZE, before: '500'}},
			]);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)).toMatchObject({hasMore: true, isLoading: false});
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.posts.map((entry) => entry.id)).toEqual(['450']);
		});

		it('asks again by itself after at most 5 empty pages in a row, then waits for the older posts button', async () => {
			vi.useFakeTimers();
			let cursor = 1000;
			vi.mocked(http.get).mockImplementation(async () => reply([], 200, {'x-next-before': String(--cursor)}));
			FeedTimeline.open(HOME_TIMELINE);

			const loading = FeedCommands.loadNextPage(HOME_TIMELINE);
			await vi.advanceTimersByTimeAsync(60_000);
			await loading;

			// The first request and 5 automatic ones, 600 ms apart: 6 requests in 3 s, under 20 per 10 s.
			expect(http.get).toHaveBeenCalledTimes(6);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)).toMatchObject({
				hasMore: true,
				isLoading: false,
				failure: 'paused',
			});
			await FeedCommands.loadNextPage(HOME_TIMELINE);
			expect(http.get).toHaveBeenCalledTimes(6);

			const resumed = FeedCommands.retry(HOME_TIMELINE);
			await vi.advanceTimersByTimeAsync(60_000);
			await resumed;

			expect(vi.mocked(http.get).mock.calls[6]).toEqual([
				Endpoints.FEED_HOME,
				{query: {limit: FEED_PAGE_SIZE, before: '994'}},
			]);
			expect(http.get).toHaveBeenCalledTimes(12);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.failure).toBe('paused');
		});

		it('leaves the new posts button free while it waits between automatic pages', async () => {
			vi.useFakeTimers();
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([], 200, {'x-next-before': '500'}))
				.mockResolvedValueOnce(reply([wirePost(900)]));
			FeedTimeline.open(HOME_TIMELINE);

			const loading = FeedCommands.loadNextPage(HOME_TIMELINE);
			await vi.advanceTimersByTimeAsync(0);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.isLoading).toBe(false);
			await FeedCommands.refresh(HOME_TIMELINE);
			await vi.advanceTimersByTimeAsync(600);
			await loading;

			// The refresh started the list over, so the automatic page of the old list is dropped.
			expect(vi.mocked(http.get).mock.calls).toEqual([
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE}}],
				[Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE}}],
			]);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.posts.map((entry) => entry.id)).toEqual(['900']);
		});

		it('pages a user posts list on its own endpoint', async () => {
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([wirePost(10)]))
				.mockResolvedValueOnce(reply([]));
			FeedTimeline.open(userTimelineKey('42'));
			await FeedCommands.loadNextPage(userTimelineKey('42'));
			await FeedCommands.loadNextPage(userTimelineKey('42'));
			expect(vi.mocked(http.get).mock.calls).toEqual([
				[Endpoints.USER_FEED_POSTS('42'), {query: {limit: FEED_PAGE_SIZE}}],
				[Endpoints.USER_FEED_POSTS('42'), {query: {limit: FEED_PAGE_SIZE, before: '10'}}],
			]);
		});

		it('loads discover pages from /feed/discover with cursor and X-Next-Cursor', async () => {
			vi.mocked(http.get)
				.mockResolvedValueOnce(
					reply([wirePost(300), wirePost(299)], 200, {'x-next-cursor': '17.20', 'x-next-before': '1'}),
				)
				.mockResolvedValueOnce(reply([wirePost(250)]));
			FeedTimeline.open(DISCOVER_TIMELINE);
			await FeedCommands.loadNextPage(DISCOVER_TIMELINE);
			await FeedCommands.loadNextPage(DISCOVER_TIMELINE);
			await FeedCommands.loadNextPage(DISCOVER_TIMELINE);
			expect(DISCOVER_PAGE_SIZE).toBe(20);
			expect(vi.mocked(http.get).mock.calls).toEqual([
				[Endpoints.FEED_DISCOVER, {query: {limit: 20}}],
				[Endpoints.FEED_DISCOVER, {query: {limit: 20, cursor: '17.20'}}],
			]);
			expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.posts.map((entry) => entry.id)).toEqual([
				'300',
				'299',
				'250',
			]);
			expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.hasMore).toBe(false);
		});

		// Discover pages by snapshot offset, and each API process may hold another snapshot: after 20 new posts rank in,
		// the next page can repeat only posts already shown. It adds nothing to scroll, so the list asks on by itself.
		it('asks for the next discover page by itself when a page only repeats posts already shown', async () => {
			vi.useFakeTimers();
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([wirePost(300), wirePost(299)], 200, {'x-next-cursor': '17.20'}))
				.mockResolvedValueOnce(reply([wirePost(299), wirePost(300)], 200, {'x-next-cursor': '18.40'}))
				.mockResolvedValueOnce(reply([wirePost(250)]));
			FeedTimeline.open(DISCOVER_TIMELINE);

			await FeedCommands.loadNextPage(DISCOVER_TIMELINE);
			const loading = FeedCommands.loadNextPage(DISCOVER_TIMELINE);
			await vi.advanceTimersByTimeAsync(600);
			await loading;

			expect(vi.mocked(http.get).mock.calls).toEqual([
				[Endpoints.FEED_DISCOVER, {query: {limit: 20}}],
				[Endpoints.FEED_DISCOVER, {query: {limit: 20, cursor: '17.20'}}],
				[Endpoints.FEED_DISCOVER, {query: {limit: 20, cursor: '18.40'}}],
			]);
			expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.posts.map((entry) => entry.id)).toEqual([
				'300',
				'299',
				'250',
			]);
			expect(FeedTimeline.getTimeline(DISCOVER_TIMELINE)!.hasMore).toBe(false);
		});

		it('the new posts button pulls the newest page and replaces the list, with no before cursor', async () => {
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([wirePost(300), wirePost(299)]))
				.mockResolvedValueOnce(reply([wirePost(400), wirePost(300)]));
			FeedTimeline.open(HOME_TIMELINE);
			await FeedCommands.loadNextPage(HOME_TIMELINE);
			await FeedCommands.refresh(HOME_TIMELINE);
			expect(vi.mocked(http.get).mock.calls[1]).toEqual([Endpoints.FEED_HOME, {query: {limit: FEED_PAGE_SIZE}}]);
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.posts.map((entry) => entry.id)).toEqual(['400', '300']);
		});

		it('a 403 (feed off or hidden posts) stops the list instead of retrying', async () => {
			vi.mocked(http.get).mockRejectedValueOnce(refusal('GET', 403));
			FeedTimeline.open(userTimelineKey('42'));
			await FeedCommands.loadNextPage(userTimelineKey('42'));
			const timeline = FeedTimeline.getTimeline(userTimelineKey('42'))!;
			expect(timeline.failure).toBe('forbidden');
			expect(timeline.hasMore).toBe(false);
			await FeedCommands.loadNextPage(userTimelineKey('42'));
			expect(http.get).toHaveBeenCalledTimes(1);
		});

		it('drops a page requested before a new session, which may belong to the previous account', async () => {
			const request = deferred<RestResponse<unknown>>();
			vi.mocked(http.get).mockReturnValueOnce(request.promise);
			FeedTimeline.open(HOME_TIMELINE);
			const loading = FeedCommands.refresh(HOME_TIMELINE);
			FeedTimeline.handleGatewayReady();
			request.resolve(reply([wirePost(300)]));
			await loading;
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)).toMatchObject({posts: [], fetchedAt: null, isLoading: false});
		});
	});

	describe('likes', () => {
		beforeEach(() => {
			FeedTimeline.open(HOME_TIMELINE);
			FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(100, {like_count: 4})], false);
		});

		it('likes at once and keeps the like when the server agrees', async () => {
			const request = deferred<RestResponse<unknown>>();
			vi.mocked(http.put).mockReturnValueOnce(request.promise);
			const outcome = FeedCommands.setLiked('100', true);
			expect(post('100')).toMatchObject({liked: true, likeCount: 5});
			request.resolve(reply(null, 204));
			await expect(outcome).resolves.toBe('ok');
			expect(http.put).toHaveBeenCalledWith(Endpoints.FEED_POST_LIKE('100'));
			expect(post('100')).toMatchObject({liked: true, likeCount: 5});
		});

		it('rolls the like back when the server refuses', async () => {
			const request = deferred<RestResponse<unknown>>();
			vi.mocked(http.put).mockReturnValueOnce(request.promise);
			const outcome = FeedCommands.setLiked('100', true);
			expect(post('100')).toMatchObject({liked: true, likeCount: 5});
			request.reject(refusal('PUT', 500));
			await expect(outcome).resolves.toBe('failed');
			expect(post('100')).toMatchObject({liked: false, likeCount: 4});
		});

		it('rolls an unlike back when the server refuses', async () => {
			FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(100, {like_count: 4, liked: true})], true);
			vi.mocked(http.delete).mockRejectedValueOnce(refusal('DELETE', 500));
			await expect(FeedCommands.setLiked('100', false)).resolves.toBe('failed');
			expect(post('100')).toMatchObject({liked: true, likeCount: 4});
		});

		it('drops the post when it is gone (404)', async () => {
			vi.mocked(http.put).mockRejectedValueOnce(refusal('PUT', 404));
			await expect(FeedCommands.setLiked('100', true)).resolves.toBe('gone');
			expect(post('100')).toBeNull();
		});

		it('ignores a second click while the first is in flight', async () => {
			const request = deferred<RestResponse<unknown>>();
			vi.mocked(http.put).mockReturnValueOnce(request.promise);
			const first = FeedCommands.setLiked('100', true);
			await FeedCommands.setLiked('100', false);
			expect(http.delete).not.toHaveBeenCalled();
			request.resolve(reply(null, 204));
			await first;
			expect(post('100')).toMatchObject({liked: true, likeCount: 5});
		});
	});

	describe('posting', () => {
		it('uploads the images through the presigned feed upload and sends their upload keys', async () => {
			const png = new File([new Uint8Array(10)], 'a.png', {type: 'image/png'});
			const gif = new File([new Uint8Array(20)], 'b.gif', {type: 'image/gif'});
			vi.mocked(http.post)
				.mockResolvedValueOnce(
					reply({
						attachments: [
							{
								upload_mode: 'singlepart',
								id: 1,
								filename: 'b.gif',
								upload_filename: 'up-b',
								upload_url: 'https://s3.test/b',
								file_size: 20,
								content_type: 'image/gif',
							},
							{
								upload_mode: 'singlepart',
								id: 0,
								filename: 'a.png',
								upload_filename: 'up-a',
								upload_url: 'https://s3.test/a',
								file_size: 10,
								content_type: 'image/png',
							},
						],
					}),
				)
				.mockResolvedValueOnce(reply(wirePost(500)));
			vi.mocked(http.put).mockResolvedValue(reply(null));
			FeedTimeline.open(HOME_TIMELINE);

			await expect(FeedCommands.createPost('  merhaba  ', [png, gif])).resolves.toBe('ok');

			expect(http.post).toHaveBeenNthCalledWith(1, Endpoints.FEED_ATTACHMENTS, {
				body: {
					attachments: [
						{id: 0, filename: 'a.png', file_size: 10, content_type: 'image/png'},
						{id: 1, filename: 'b.gif', file_size: 20, content_type: 'image/gif'},
					],
				},
			});
			expect(http.put).toHaveBeenCalledWith('https://s3.test/a', {body: png, headers: {'Content-Type': 'image/png'}});
			expect(http.put).toHaveBeenCalledWith('https://s3.test/b', {body: gif, headers: {'Content-Type': 'image/gif'}});
			expect(http.post).toHaveBeenNthCalledWith(2, Endpoints.FEED_POSTS, {
				body: {
					content: 'merhaba',
					attachments: [
						{id: 0, filename: 'a.png', upload_filename: 'up-a', file_size: 10, content_type: 'image/png'},
						{id: 1, filename: 'b.gif', upload_filename: 'up-b', file_size: 20, content_type: 'image/gif'},
					],
				},
			});
			expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.posts.map((entry) => entry.id)).toEqual(['500']);
		});

		it('posts text alone without asking for uploads', async () => {
			vi.mocked(http.post).mockResolvedValueOnce(reply(wirePost(501)));
			await expect(FeedCommands.createPost('only text', [])).resolves.toBe('ok');
			expect(http.post).toHaveBeenCalledTimes(1);
			expect(http.post).toHaveBeenCalledWith(Endpoints.FEED_POSTS, {body: {content: 'only text'}});
		});

		it('refuses images of other types or more than four before any request', async () => {
			const svg = new File(['<svg/>'], 'x.svg', {type: 'image/svg+xml'});
			const pngs = Array.from({length: 5}, (_, index) => new File(['x'], `${index}.png`, {type: 'image/png'}));
			await expect(FeedCommands.createPost('hi', [svg])).resolves.toBe('invalid');
			await expect(FeedCommands.createPost('hi', pngs)).resolves.toBe('invalid');
			await expect(FeedCommands.createPost('   ', [])).resolves.toBe('invalid');
			expect(http.post).not.toHaveBeenCalled();
		});

		it('does not publish when an image fails to upload', async () => {
			const png = new File(['x'], 'a.png', {type: 'image/png'});
			vi.mocked(http.post).mockResolvedValueOnce(
				reply({
					attachments: [
						{
							upload_mode: 'singlepart',
							id: 0,
							filename: 'a.png',
							upload_filename: 'up-a',
							upload_url: 'https://s3.test/a',
							file_size: 1,
							content_type: 'image/png',
						},
					],
				}),
			);
			vi.mocked(http.put).mockRejectedValueOnce(new Error('Network error during request'));
			await expect(FeedCommands.createPost('hi', [png])).resolves.toBe('failed');
			expect(http.post).toHaveBeenCalledTimes(1);
		});

		// Micup: the server sets the public bit from the author's profile visibility; no public field goes out.
		it('sends the poll with a new post and never a public field', async () => {
			const poll = {options: ['Çay', 'Kahve'], durationHours: 24};
			vi.mocked(http.post).mockResolvedValue(reply(wirePost(502)));
			await expect(FeedCommands.createPost('  Hangisi?  ', [], {poll})).resolves.toBe('ok');
			await expect(FeedCommands.createPost('varsayılan', [])).resolves.toBe('ok');
			expect(vi.mocked(http.post).mock.calls).toEqual([
				[Endpoints.FEED_POSTS, {body: {content: 'Hangisi?', poll: {options: ['Çay', 'Kahve'], duration_hours: 24}}}],
				[Endpoints.FEED_POSTS, {body: {content: 'varsayılan'}}],
			]);
			// A poll needs text as its question and goes without images.
			const png = new File(['x'], 'a.png', {type: 'image/png'});
			await expect(FeedCommands.createPost('   ', [], {poll})).resolves.toBe('invalid');
			await expect(FeedCommands.createPost('Hangisi?', [png], {poll})).resolves.toBe('invalid');
			expect(http.post).toHaveBeenCalledTimes(2);
		});

		// The server normalizes poll options (hidden characters) before it checks repeats, so a post the client let through
		// can still be refused as malformed; saying "try again in a moment" would be wrong.
		it('reports a 400 from the server as invalid, not as a failure to retry', async () => {
			vi.mocked(http.post).mockRejectedValueOnce(refusal('POST', 400));
			const poll = {options: ['Tea', 'Coffee'], durationHours: 24};
			await expect(FeedCommands.createPost('Tea?', [], {poll})).resolves.toBe('invalid');
		});

		// Videos go to Bunny Stream through FeedVideoCommands.postVideo; this path takes images only.
		it('refuses a video before any request', async () => {
			const clip = new File([new Uint8Array(30)], 'clip.mp4', {type: 'video/mp4'});
			const png = new File(['x'], 'a.png', {type: 'image/png'});
			await expect(FeedCommands.createPost('hi', [clip])).resolves.toBe('invalid');
			await expect(FeedCommands.createPost('', [clip], {poll: null})).resolves.toBe('invalid');
			await expect(FeedCommands.createPost('hi', [png, clip])).resolves.toBe('invalid');
			expect(http.post).not.toHaveBeenCalled();
		});
	});

	describe('polls', () => {
		const expiresAt = '2026-10-01T00:00:00.000Z';
		const poll = (votes: Array<number> | null, voted: number | null) => ({
			options: ['a', 'b'],
			expires_at: expiresAt,
			votes,
			voted,
		});

		beforeEach(() => {
			FeedTimeline.open(HOME_TIMELINE);
			FeedTimeline.open(DISCOVER_TIMELINE);
			FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(100, {public: true, poll: poll(null, null)})], false);
			FeedTimeline.handleFetchSuccess(
				DISCOVER_TIMELINE,
				[wirePost(100, {public: true, poll: poll(null, null)})],
				true,
				'1.1',
			);
		});

		it('votes and replaces the post with the server answer', async () => {
			vi.mocked(http.put).mockResolvedValueOnce(reply(wirePost(100, {public: true, poll: poll([4, 2], 1)})));
			await expect(FeedCommands.votePoll('100', 1)).resolves.toBe('ok');
			expect(http.put).toHaveBeenCalledWith(Endpoints.FEED_POST_POLL_VOTE('100'), {body: {option: 1}});
			for (const key of [HOME_TIMELINE, DISCOVER_TIMELINE]) {
				expect(FeedTimeline.getTimeline(key)!.posts[0]!.poll).toEqual({
					options: ['a', 'b'],
					expiresAt,
					votes: [4, 2],
					voted: 1,
				});
			}
		});

		it('on 409 reloads the post instead of reporting a failure', async () => {
			vi.mocked(http.put).mockRejectedValueOnce(refusal('PUT', 409));
			vi.mocked(http.get).mockResolvedValueOnce(reply(wirePost(100, {public: true, poll: poll([5, 2], 0)})));
			await expect(FeedCommands.votePoll('100', 1)).resolves.toBe('ok');
			expect(http.get).toHaveBeenCalledWith(Endpoints.FEED_POST('100'));
			expect(post('100')!.poll).toMatchObject({votes: [5, 2], voted: 0});
		});

		it('on 404 removes the post', async () => {
			vi.mocked(http.put).mockRejectedValueOnce(refusal('PUT', 404));
			await expect(FeedCommands.votePoll('100', 0)).resolves.toBe('gone');
			expect(post('100')).toBeNull();
			expect(http.get).not.toHaveBeenCalled();
		});
	});

	describe('reloading a post', () => {
		beforeEach(() => {
			FeedTimeline.open(HOME_TIMELINE);
			FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(100), wirePost(99)], false);
		});

		// The feed video player asks for this when the signed URLs it has are about to run out.
		it("puts the server's copy in place of the post and gives it back", async () => {
			const fresh = wirePost(100, {like_count: 5});
			vi.mocked(http.get).mockResolvedValueOnce(reply(fresh));
			await expect(FeedCommands.reloadPost('100')).resolves.toEqual(fresh);
			expect(http.get).toHaveBeenCalledWith(Endpoints.FEED_POST('100'));
			expect(post('100')!.likeCount).toBe(5);
		});

		it('drops a post that is gone and keeps it on other failures', async () => {
			vi.mocked(http.get).mockRejectedValueOnce(refusal('GET', 500));
			await expect(FeedCommands.reloadPost('99')).resolves.toBeNull();
			expect(post('99')).not.toBeNull();
			vi.mocked(http.get).mockRejectedValueOnce(refusal('GET', 404));
			await expect(FeedCommands.reloadPost('99')).resolves.toBeNull();
			expect(post('99')).toBeNull();
		});
	});

	describe('deleting', () => {
		beforeEach(() => {
			FeedTimeline.open(HOME_TIMELINE);
			FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(100), wirePost(99)], false);
		});

		it('removes the post once the server deletes it', async () => {
			vi.mocked(http.delete).mockResolvedValueOnce(reply(null, 204));
			await expect(FeedCommands.deletePost('100')).resolves.toBe('ok');
			expect(http.delete).toHaveBeenCalledWith(Endpoints.FEED_POST('100'));
			expect(post('100')).toBeNull();
		});

		it('treats an already deleted post (404) as deleted', async () => {
			vi.mocked(http.delete).mockRejectedValueOnce(refusal('DELETE', 404));
			await expect(FeedCommands.deletePost('100')).resolves.toBe('ok');
			expect(post('100')).toBeNull();
		});

		it('keeps the post when the server refuses (403)', async () => {
			vi.mocked(http.delete).mockRejectedValueOnce(refusal('DELETE', 403));
			await expect(FeedCommands.deletePost('100')).resolves.toBe('forbidden');
			expect(post('100')).not.toBeNull();
		});
	});

	describe('comments', () => {
		beforeEach(() => {
			FeedTimeline.open(HOME_TIMELINE);
			FeedTimeline.handleFetchSuccess(HOME_TIMELINE, [wirePost(100, {comment_count: 3})], false);
			FeedTimeline.openThread('100');
		});

		it('continues an empty comment page from the raw server cursor', async () => {
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([], 200, {'x-next-before': '25'}))
				.mockResolvedValueOnce(reply([wireComment(20, '100')]));
			await FeedCommands.loadComments('100');
			expect(FeedTimeline.getThread('100')).toMatchObject({hasMore: true, isLoading: false});
			await FeedCommands.loadComments('100');
			expect(http.get).toHaveBeenLastCalledWith(Endpoints.FEED_POST_COMMENTS('100'), {
				query: {limit: FEED_PAGE_SIZE, before: '25'},
			});
			expect(FeedTimeline.getThread('100')!.comments.map((comment) => comment.id)).toEqual(['20']);
		});

		it('pages comments with the oldest loaded comment as the before cursor', async () => {
			vi.mocked(http.get)
				.mockResolvedValueOnce(reply([wireComment(30, '100'), wireComment(29, '100')]))
				.mockResolvedValueOnce(reply([wireComment(20, '100')]))
				.mockResolvedValueOnce(reply([]));
			await FeedCommands.loadComments('100');
			await FeedCommands.loadComments('100');
			await FeedCommands.loadComments('100');
			await FeedCommands.loadComments('100');
			expect(vi.mocked(http.get).mock.calls).toEqual([
				[Endpoints.FEED_POST_COMMENTS('100'), {query: {limit: FEED_PAGE_SIZE}}],
				[Endpoints.FEED_POST_COMMENTS('100'), {query: {limit: FEED_PAGE_SIZE, before: '29'}}],
				[Endpoints.FEED_POST_COMMENTS('100'), {query: {limit: FEED_PAGE_SIZE, before: '20'}}],
			]);
			expect(FeedTimeline.getThread('100')!.comments.map((comment) => comment.id)).toEqual(['30', '29', '20']);
		});

		it('adds a new comment on top and counts it', async () => {
			vi.mocked(http.post).mockResolvedValueOnce(reply(wireComment(40, '100')));
			await expect(FeedCommands.createComment('100', '  güzel  ')).resolves.toBe('ok');
			expect(http.post).toHaveBeenCalledWith(Endpoints.FEED_POST_COMMENTS('100'), {body: {content: 'güzel'}});
			expect(FeedTimeline.getThread('100')!.comments[0]!.id).toBe('40');
			expect(post('100')!.commentCount).toBe(4);
		});

		it('deletes a comment and uncounts it', async () => {
			FeedTimeline.handleThreadSuccess('100', [wireComment(30, '100')]);
			vi.mocked(http.delete).mockResolvedValueOnce(reply(null, 204));
			await expect(FeedCommands.deleteComment('100', '30')).resolves.toBe('ok');
			expect(http.delete).toHaveBeenCalledWith(Endpoints.FEED_POST_COMMENT('100', '30'));
			expect(FeedTimeline.getThread('100')!.comments).toEqual([]);
			expect(post('100')!.commentCount).toBe(2);
		});

		it('uncounts a comment already gone (404) and keeps the post', async () => {
			FeedTimeline.handleThreadSuccess('100', [wireComment(30, '100')]);
			vi.mocked(http.delete).mockRejectedValueOnce(refusal('DELETE', 404, APIErrorCodes.UNKNOWN_FEED_COMMENT));
			await expect(FeedCommands.deleteComment('100', '30')).resolves.toBe('ok');
			expect(FeedTimeline.getThread('100')!.comments).toEqual([]);
			expect(post('100')!.commentCount).toBe(2);
		});

		it('drops the post when deleting a comment finds the post gone (404)', async () => {
			FeedTimeline.handleThreadSuccess('100', [wireComment(30, '100')]);
			vi.mocked(http.delete).mockRejectedValueOnce(refusal('DELETE', 404, APIErrorCodes.UNKNOWN_FEED_POST));
			await expect(FeedCommands.deleteComment('100', '30')).resolves.toBe('ok');
			expect(post('100')).toBeNull();
			expect(FeedTimeline.getThread('100')).toBeNull();
		});

		it('drops the post when its comments are gone (404)', async () => {
			vi.mocked(http.get).mockRejectedValueOnce(refusal('GET', 404));
			await FeedCommands.loadComments('100');
			expect(post('100')).toBeNull();
		});
	});

	describe('reports', () => {
		it('reports a post and a comment on the feed report endpoints', async () => {
			vi.mocked(http.post).mockResolvedValue(reply({}));
			await FeedCommands.reportPost('100', 'spam');
			await FeedCommands.reportComment('100', '30', 'harassment');
			expect(http.post).toHaveBeenNthCalledWith(1, Endpoints.REPORT_FEED_POST, {
				body: {post_id: '100', category: 'spam'},
			});
			expect(http.post).toHaveBeenNthCalledWith(2, Endpoints.REPORT_FEED_COMMENT, {
				body: {post_id: '100', comment_id: '30', category: 'harassment'},
			});
		});
	});
});
