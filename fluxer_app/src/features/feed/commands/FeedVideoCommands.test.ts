// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {Endpoints} from '@app/features/app/constants/Endpoints';
import {HttpError} from '@app/features/platform/types/EndpointError';
import type {RestResponse} from '@app/features/platform/types/TransportTypes';
import type {FeedPostResponse, FeedVideoUploadResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
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
vi.mock('@app/features/feed/utils/FeedVideoUpload', () => ({uploadFeedVideo: vi.fn()}));
vi.mock('@app/features/auth/state/Authentication', async () => {
	const {observable} = await import('mobx');
	return {default: observable({currentUserId: '1' as string | null})};
});

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message}}),
}));
vi.mock('@app/features/feed/components/FeedItemMenu', () => ({toastFeedFailure: vi.fn()}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));

const {AccountScopedWork} = await import('@app/features/platform/state/AccountScopedWork');
const {http} = await import('@app/features/platform/transport/RestTransport');
const {uploadFeedVideo} = await import('@app/features/feed/utils/FeedVideoUpload');
const FeedVideoCommands = await import('@app/features/feed/commands/FeedVideoCommands');
const {default: FeedPendingVideos} = await import('@app/features/feed/state/FeedPendingVideos');
const {default: FeedTimeline, HOME_TIMELINE} = await import('@app/features/feed/state/FeedTimeline');

const {FeedPendingVideos: PendingVideoList} = await import('@app/features/feed/components/FeedPendingVideos');

const VIDEO_ID = '0b6c1f3e-6d2a-4f55-9a1e-2f8f5b1c7d90';

function reply<T>(body: T, status = 200): RestResponse<T> {
	return {ok: status < 300, status, statusText: '', headers: {}, body};
}

function ticket(signature = 'sig-1'): FeedVideoUploadResponse {
	return {
		id: VIDEO_ID,
		library_id: '761025',
		upload: {endpoint: 'https://video.bunnycdn.com/tusupload', signature, expires: 1_900_000_000},
	};
}

function wirePost(id: string): FeedPostResponse {
	return {
		id,
		author: {
			id: '7',
			username: 'user7',
			discriminator: '0001',
			global_name: null,
			avatar: null,
			avatar_color: null,
			flags: 0,
		},
		content: null,
		attachments: [],
		edited_at: null,
		like_count: 0,
		comment_count: 0,
		liked: false,
	};
}

const listing = (state: string, postId: string | null = null) =>
	reply([{id: VIDEO_ID, state, created_at: '2026-09-27T18:00:00.000Z', post_id: postId}]);
const clip = () => new File([new Uint8Array(30)], 'clip.mov', {type: 'video/quicktime'});
const listCalls = () => vi.mocked(http.get).mock.calls.filter(([path]) => path === Endpoints.FEED_VIDEOS).length;
const UPLOAD_URL = 'https://video.bunnycdn.com/tusupload/up-1';

describe('FeedVideoCommands', () => {
	let visibility: DocumentVisibilityState;

	beforeEach(async () => {
		await AccountScopedWork.runSuspended('account-switch', async () => {});
		vi.useFakeTimers();
		for (const method of [http.get, http.post, http.delete, uploadFeedVideo]) vi.mocked(method).mockReset();
		FeedPendingVideos.reset();
		FeedTimeline.reset();
		visibility = 'visible';
		Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => visibility});
	});

	afterEach(async () => {
		await AccountScopedWork.runSuspended('account-switch', async () => {});
		await vi.runOnlyPendingTimersAsync();
		vi.useRealTimers();
	});

	it('releases an account switch without waiting for the new list response', async () => {
		vi.mocked(http.get).mockResolvedValueOnce(listing('processing'));
		const stop = FeedVideoCommands.watchPending();
		await vi.advanceTimersByTimeAsync(0);
		let answer!: (value: RestResponse<unknown>) => void;
		vi.mocked(http.get).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					answer = resolve;
				}) as never,
		);
		let released = false;
		const switching = AccountScopedWork.runSuspended('account-switch', async () => {}).then(() => {
			released = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(listCalls()).toBe(2);
			expect(released).toBe(true);
		} finally {
			answer(listing('scanning'));
			await switching;
			stop();
		}
	});

	it('keeps the mounted list polling the new account after suspension with one shared timer', async () => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.mocked(http.get).mockResolvedValue(listing('processing'));
		const watch = vi.spyOn(FeedVideoCommands, 'watchPending');
		const container = document.createElement('div');
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(PendingVideoList)));
			expect(listCalls()).toBe(1);
			await act(async () =>
				AccountScopedWork.runSuspended('account-switch', async () => {
					expect(FeedPendingVideos.videos).toEqual([]);
					await vi.advanceTimersByTimeAsync(60_000);
					expect(listCalls()).toBe(1);
				}),
			);
			expect(watch).toHaveBeenCalledTimes(1);
			expect(listCalls()).toBe(2);
			await act(async () => vi.advanceTimersByTimeAsync(FeedVideoCommands.FEED_VIDEO_POLL_MS));
			expect(listCalls()).toBe(3);
		} finally {
			act(() => root.unmount());
			watch.mockRestore();
		}
		await vi.advanceTimersByTimeAsync(60_000);
		expect(listCalls()).toBe(3);
	});

	// Micup: the server sets the public bit from the author's profile visibility; no public field goes out.
	it('posts the text with the video and never a public field', async () => {
		let finishUpload!: () => void;
		vi.mocked(uploadFeedVideo).mockReturnValueOnce(
			new Promise<void>((resolve) => {
				finishUpload = resolve;
			}),
		);
		vi.mocked(http.post)
			.mockResolvedValueOnce(reply(ticket()))
			.mockResolvedValueOnce(reply(ticket('sig-2')));
		const file = clip();

		await expect(FeedVideoCommands.postVideo(file, {content: '  Hello  '})).resolves.toBe('ok');
		expect(http.post).toHaveBeenCalledWith(Endpoints.FEED_VIDEOS, {
			body: {filename: 'clip.mov', file_size: 30, content_type: 'video/quicktime', content: 'Hello'},
		});
		// The upload runs on after the composer is free again; its row shows it.
		expect(FeedPendingVideos.videos).toEqual([expect.objectContaining({id: VIDEO_ID, state: 'uploading', file})]);
		const [uploadedFile, uploadTicket, hooks] = vi.mocked(uploadFeedVideo).mock.calls[0]!;
		expect([uploadedFile, uploadTicket]).toEqual([file, ticket()]);
		hooks.onProgress?.(15, 30);
		expect(FeedPendingVideos.videos[0]!.progress).toBe(0.5);
		await expect(hooks.resign()).resolves.toEqual(ticket('sig-2'));
		expect(http.post).toHaveBeenLastCalledWith(Endpoints.FEED_VIDEO_SIGNATURE(VIDEO_ID));

		finishUpload();
		await vi.advanceTimersByTimeAsync(0);
		expect(FeedPendingVideos.videos[0]).toMatchObject({state: 'processing', progress: null});

		vi.mocked(http.post).mockResolvedValueOnce(reply({...ticket(), id: 'second'}));
		vi.mocked(uploadFeedVideo).mockResolvedValueOnce();
		await expect(FeedVideoCommands.postVideo(clip(), {content: '   '})).resolves.toBe('ok');
		expect(http.post).toHaveBeenLastCalledWith(Endpoints.FEED_VIDEOS, {
			body: {filename: 'clip.mov', file_size: 30, content_type: 'video/quicktime'},
		});
	});

	it('refuses another type before any request and reports refusals of the server', async () => {
		const gif = new File(['g'], 'a.gif', {type: 'image/gif'});
		await expect(FeedVideoCommands.postVideo(gif, {content: ''})).resolves.toBe('invalid');
		expect(http.post).not.toHaveBeenCalled();

		vi.mocked(http.post).mockRejectedValueOnce(new HttpError({method: 'POST', path: '/feed/videos', status: 403}));
		await expect(FeedVideoCommands.postVideo(clip(), {content: ''})).resolves.toBe('forbidden');
		vi.mocked(http.post).mockRejectedValueOnce(new HttpError({method: 'POST', path: '/feed/videos', status: 429}));
		await expect(FeedVideoCommands.postVideo(clip(), {content: ''})).resolves.toBe('failed');
		expect(uploadFeedVideo).not.toHaveBeenCalled();
		expect(FeedPendingVideos.videos).toEqual([]);
	});

	// the last PATCH may have landed although its answer was lost, so a failure never deletes; the
	// server's list tells whether it has the whole file.
	it('marks a failed upload without deleting it and follows the server when it has the whole file', async () => {
		vi.mocked(http.post).mockResolvedValue(reply(ticket()));
		vi.mocked(uploadFeedVideo).mockRejectedValue(new Error('Bunny TUS answered 404'));
		vi.mocked(http.get).mockResolvedValueOnce(listing('uploading')).mockResolvedValueOnce(listing('processing'));
		await FeedVideoCommands.postVideo(clip(), {content: ''});
		await vi.advanceTimersByTimeAsync(0);
		expect(FeedPendingVideos.videos[0]).toMatchObject({state: 'failed', resumable: true});
		expect(listCalls()).toBe(1);

		FeedPendingVideos.reset();
		await FeedVideoCommands.postVideo(clip(), {content: ''});
		await vi.advanceTimersByTimeAsync(0);
		expect(FeedPendingVideos.videos[0]!.state).toBe('processing');
		expect(http.delete).not.toHaveBeenCalled();
	});

	it('resumes a failed upload with a new signature, from the TUS upload it had', async () => {
		vi.mocked(http.post).mockResolvedValueOnce(reply(ticket()));
		vi.mocked(uploadFeedVideo).mockImplementationOnce(async (_file, _ticket, {onCreated}) => {
			onCreated?.(UPLOAD_URL);
			throw new TypeError('Failed to fetch');
		});
		vi.mocked(http.get).mockResolvedValue(listing('uploading'));
		const file = clip();
		await FeedVideoCommands.postVideo(file, {content: ''});
		await vi.advanceTimersByTimeAsync(0);
		expect(FeedPendingVideos.videos[0]!.state).toBe('failed');

		vi.mocked(http.post).mockResolvedValueOnce(reply(ticket('sig-2')));
		vi.mocked(uploadFeedVideo).mockResolvedValueOnce();
		await expect(FeedVideoCommands.resumeVideo(VIDEO_ID)).resolves.toBe('ok');
		expect(http.post).toHaveBeenLastCalledWith(Endpoints.FEED_VIDEO_SIGNATURE(VIDEO_ID));
		const [resumedFile, resumedTicket, hooks] = vi.mocked(uploadFeedVideo).mock.calls[1]!;
		expect([resumedFile, resumedTicket, hooks.uploadUrl]).toEqual([file, ticket('sig-2'), UPLOAD_URL]);
		await vi.advanceTimersByTimeAsync(0);
		expect(FeedPendingVideos.videos[0]).toMatchObject({state: 'processing'});
		expect(http.delete).not.toHaveBeenCalled();
	});

	// 404: the server has the whole file, failed the video, or 6 h passed since it started (no new signature then).
	it('stops offering to resume when the server refuses a new signature', async () => {
		vi.mocked(http.post).mockResolvedValueOnce(reply(ticket()));
		vi.mocked(uploadFeedVideo).mockRejectedValueOnce(new Error('Bunny TUS answered 400'));
		vi.mocked(http.get).mockResolvedValue(listing('uploading'));
		await FeedVideoCommands.postVideo(clip(), {content: ''});
		await vi.advanceTimersByTimeAsync(0);
		vi.mocked(http.post).mockRejectedValueOnce(new HttpError({method: 'POST', path: '/feed/videos', status: 404}));
		await expect(FeedVideoCommands.resumeVideo(VIDEO_ID)).resolves.toBe('gone');
		expect(FeedPendingVideos.videos[0]).toMatchObject({state: 'failed', resumable: false});
		expect(uploadFeedVideo).toHaveBeenCalledTimes(1);
		expect(http.delete).not.toHaveBeenCalled();
	});

	// A shared device: the next account must not see the file names and first frames, nor keep uploading or polling.
	it('drops the uploads, the polling and the rows of an account that signs out or changes', async () => {
		vi.mocked(http.post).mockResolvedValueOnce(reply(ticket()));
		vi.mocked(uploadFeedVideo).mockImplementationOnce(
			(_file, _ticket, {signal}) =>
				new Promise((_, reject) =>
					signal.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError'))),
				),
		);
		vi.mocked(http.get).mockResolvedValue(
			reply([
				{id: VIDEO_ID, state: 'uploading', created_at: '2026-09-27T18:00:00.000Z', post_id: null},
				{id: 'other', state: 'processing', created_at: '2026-09-27T18:00:00.000Z', post_id: null},
			]),
		);
		const stop = FeedVideoCommands.watchPending();
		await FeedVideoCommands.postVideo(clip(), {content: ''});
		await vi.advanceTimersByTimeAsync(0);
		const {signal} = vi.mocked(uploadFeedVideo).mock.calls[0]![2];
		expect(FeedPendingVideos.videos).toHaveLength(2);

		await AccountScopedWork.runSuspended('logout', async () => {});
		expect(signal.aborted).toBe(true);
		expect(FeedPendingVideos.videos).toEqual([]);
		const calls = listCalls();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(listCalls()).toBe(calls);
		expect(http.delete).not.toHaveBeenCalled();
		stop();
	});

	// an answer to the previous account's request lands after the switch and is dropped.
	it('keeps the list and the posts an account asked for out of the next account', async () => {
		const switchAccount = () => AccountScopedWork.runSuspended('account-switch', async () => {});
		let answer!: (response: RestResponse<unknown>) => void;
		const later = () =>
			new Promise<RestResponse<unknown>>((resolve) => {
				answer = resolve;
			}) as never;

		vi.mocked(http.get).mockImplementationOnce(later);
		const listed = FeedVideoCommands.refreshPending();
		await switchAccount();
		answer(listing('processing'));
		await listed;
		expect(FeedPendingVideos.videos).toEqual([]);

		await switchAccount();
		FeedTimeline.open(HOME_TIMELINE);
		vi.mocked(http.get).mockResolvedValueOnce(listing('scanning'));
		await FeedVideoCommands.refreshPending();
		vi.mocked(http.get).mockResolvedValueOnce(listing('published', '900')).mockImplementationOnce(later);
		const loaded = FeedVideoCommands.refreshPending();
		await vi.advanceTimersByTimeAsync(0);
		expect(http.get).toHaveBeenLastCalledWith(Endpoints.FEED_POST('900'));
		await switchAccount();
		expect(FeedTimeline.getTimeline(HOME_TIMELINE)).toBeNull();
		FeedTimeline.open(HOME_TIMELINE);
		answer(reply(wirePost('900')));
		await loaded;
		expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.posts).toEqual([]);
		await switchAccount();
	});

	it('cancels an upload: stops sending and deletes the video', async () => {
		vi.mocked(http.post).mockResolvedValueOnce(reply(ticket()));
		vi.mocked(http.delete).mockResolvedValue(reply(undefined, 204));
		vi.mocked(uploadFeedVideo).mockImplementationOnce(
			(_file, _ticket, {signal}) =>
				new Promise((_, reject) =>
					signal.addEventListener('abort', () => reject(new DOMException('Upload aborted', 'AbortError'))),
				),
		);
		await FeedVideoCommands.postVideo(clip(), {content: ''});
		const {signal} = vi.mocked(uploadFeedVideo).mock.calls[0]![2];

		await expect(FeedVideoCommands.cancelVideo(VIDEO_ID)).resolves.toBe('ok');
		expect(signal.aborted).toBe(true);
		expect(http.delete).toHaveBeenCalledExactlyOnceWith(Endpoints.FEED_VIDEO(VIDEO_ID));
		expect(FeedPendingVideos.videos).toEqual([]);

		// Published or gone meanwhile (404): the row goes; the video lock is busy (409): it stays.
		vi.mocked(http.get).mockResolvedValueOnce(listing('scanning'));
		await FeedVideoCommands.refreshPending();
		vi.mocked(http.delete).mockRejectedValueOnce(new HttpError({method: 'DELETE', path: '/feed/videos', status: 409}));
		await expect(FeedVideoCommands.cancelVideo(VIDEO_ID)).resolves.toBe('failed');
		expect(FeedPendingVideos.videos).toHaveLength(1);
		vi.mocked(http.delete).mockRejectedValueOnce(new HttpError({method: 'DELETE', path: '/feed/videos', status: 404}));
		await expect(FeedVideoCommands.cancelVideo(VIDEO_ID)).resolves.toBe('ok');
		expect(FeedPendingVideos.videos).toEqual([]);
	});

	it('polls while a video is in flight and stops when none is', async () => {
		vi.mocked(http.get)
			.mockResolvedValueOnce(listing('processing'))
			.mockResolvedValueOnce(listing('scanning'))
			.mockResolvedValueOnce(reply([]));
		const stop = FeedVideoCommands.watchPending();
		await vi.advanceTimersByTimeAsync(0);
		expect(listCalls()).toBe(1);
		await vi.advanceTimersByTimeAsync(14_999);
		expect(listCalls()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(listCalls()).toBe(2);
		expect(FeedPendingVideos.videos[0]!.state).toBe('scanning');

		// Not while the page is hidden.
		visibility = 'hidden';
		await vi.advanceTimersByTimeAsync(45_000);
		expect(listCalls()).toBe(2);
		visibility = 'visible';
		await vi.advanceTimersByTimeAsync(15_000);
		expect(listCalls()).toBe(3);
		expect(FeedPendingVideos.videos).toEqual([]);

		await vi.advanceTimersByTimeAsync(120_000);
		expect(listCalls()).toBe(3);
		stop();
	});

	// The list shows in the post box of the feed page; nothing is asked for on other pages.
	it('polls only while the list of your videos is on screen', async () => {
		vi.mocked(http.get).mockResolvedValue(listing('processing'));
		const stop = FeedVideoCommands.watchPending();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(listCalls()).toBe(2);
		stop();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(listCalls()).toBe(2);

		// An upload that ends meanwhile does not start polling off the page either.
		vi.mocked(http.post).mockResolvedValueOnce(reply({...ticket(), id: 'second'}));
		vi.mocked(uploadFeedVideo).mockResolvedValueOnce();
		await FeedVideoCommands.postVideo(clip(), {content: ''});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(listCalls()).toBe(2);
	});

	it('adds a published video post to the timelines', async () => {
		FeedTimeline.open(HOME_TIMELINE);
		vi.mocked(http.get)
			.mockResolvedValueOnce(listing('scanning'))
			.mockResolvedValueOnce(listing('published', '900'))
			.mockResolvedValueOnce(reply(wirePost('900')));
		const stop = FeedVideoCommands.watchPending();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(http.get).toHaveBeenLastCalledWith(Endpoints.FEED_POST('900'));
		expect(FeedTimeline.getTimeline(HOME_TIMELINE)!.posts.map((post) => post.id)).toEqual(['900']);
		expect(FeedPendingVideos.videos).toEqual([]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(http.get).toHaveBeenCalledTimes(3);
		stop();
	});
});
