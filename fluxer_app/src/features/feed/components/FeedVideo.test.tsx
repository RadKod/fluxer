// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {FeedVideoResponse} from '@fluxer/schema/src/domains/feed/FeedResponseSchemas';
import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeHls {
	options: unknown;
	loadSource: ReturnType<typeof vi.fn>;
	attachMedia: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	handlers: Map<string, (event: string, data: {fatal: boolean}) => void>;
}

const hls = vi.hoisted(() => ({loads: 0, supported: true, instances: [] as Array<FakeHls>}));

// The light build: no subtitles, alternate audio or DRM, which Bunny's muxed HLS does not use.
vi.mock('hls.js/light', () => {
	hls.loads += 1;
	class Hls {
		static Events = {ERROR: 'hlsError'};
		static isSupported = () => hls.supported;
		loadSource = vi.fn();
		attachMedia = vi.fn();
		destroy = vi.fn();
		handlers = new Map();
		constructor(public options: unknown) {
			hls.instances.push(this as unknown as FakeHls);
		}
		on(event: string, handler: (event: string, data: {fatal: boolean}) => void) {
			this.handlers.set(event, handler);
		}
	}
	return {default: Hls};
});
vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({i18n: {_: (descriptor: {message: string}) => descriptor.message, locale: 'en-US'}}),
}));
vi.mock('@app/features/feed/commands/FeedCommands', () => ({reloadPost: vi.fn()}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/voice/components/media_player/components/VideoPlayer', () => ({
	VideoPlayer: vi.fn(() => createElement('div', {'data-testid': 'video-player'})),
}));

const FeedCommands = await import('@app/features/feed/commands/FeedCommands');
const {VideoPlayer} = await import('@app/features/voice/components/media_player/components/VideoPlayer');
const {FeedVideo} = await import('@app/features/feed/components/FeedVideo');

const VIDEO: FeedVideoResponse = {
	id: '4f5c2b8e-8a8e-4b53-9a3a-6f1d8b2c7e10',
	width: 1920,
	height: 1080,
	duration: 42,
	poster_url: 'https://vz.micup.test/4f5c/thumbnail.jpg?token=a',
	hls_url: 'https://vz.micup.test/4f5c/playlist.m3u8?token=a',
	mp4_url: 'https://vz.micup.test/4f5c/play_720p.mp4?token=a',
	// Signed URLs of a short video run 2 to 3 h from when the post was loaded.
	expires_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
};
const POST_ID = '900';
const soon = () => new Date(Date.now() + 5 * 60_000).toISOString();

describe('FeedVideo', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let canPlayType: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		vi.mocked(VideoPlayer).mockClear();
		vi.mocked(FeedCommands.reloadPost).mockReset();
		hls.supported = true;
		hls.instances.length = 0;
		canPlayType = vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('');
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});

	const render = (video: FeedVideoResponse = VIDEO) =>
		act(() => root.render(createElement(FeedVideo, {postId: POST_ID, video})));
	const play = () =>
		act(async () => {
			container.querySelector<HTMLButtonElement>('button[aria-label="Play video"]')!.click();
			await vi.dynamicImportSettled();
		});
	const playerProps = () => vi.mocked(VideoPlayer).mock.lastCall?.[0];

	it('renders the poster and a play button and loads nothing before the click', () => {
		render();
		expect(container.querySelector('img')!.getAttribute('src')).toBe(VIDEO.poster_url);
		expect(container.querySelector('button[aria-label="Play video"]')).not.toBeNull();
		expect(container.textContent).toContain('0:42');
		expect(container.querySelector('video')).toBeNull();
		expect(VideoPlayer).not.toHaveBeenCalled();
		expect(canPlayType).not.toHaveBeenCalled();
		expect(hls.loads).toBe(0);
	});

	it('plays HLS natively where the browser can', async () => {
		canPlayType.mockImplementation((type: string) => (type === 'application/vnd.apple.mpegurl' ? 'maybe' : ''));
		render();
		await play();
		expect(playerProps()).toMatchObject({
			src: VIDEO.hls_url,
			poster: VIDEO.poster_url,
			width: 1920,
			height: 1080,
			duration: 42,
			autoPlay: true,
		});
		expect(hls.loads).toBe(0);
	});

	it('loads hls.js only on the first play and attaches it where MSE is supported', async () => {
		render();
		expect(hls.loads).toBe(0);
		await play();
		expect(hls.loads).toBe(1);
		const [instance] = hls.instances;
		expect(instance!.options).toEqual({enableWorker: true, lowLatencyMode: false});
		expect(instance!.loadSource).toHaveBeenCalledWith(VIDEO.hls_url);
		const video = container.querySelector('video')!;
		expect(instance!.attachMedia).toHaveBeenCalledWith(video);
		expect(video.autoplay).toBe(true);
		expect(video.getAttribute('poster')).toBe(VIDEO.poster_url);
		expect(VideoPlayer).not.toHaveBeenCalled();
		expect(FeedCommands.reloadPost).not.toHaveBeenCalled();
	});

	it('gets fresh URLs from the server before playing a video whose URLs run out within 10 minutes', async () => {
		const fresh = {...VIDEO, hls_url: 'https://vz.micup.test/4f5c/playlist.m3u8?token=b'};
		vi.mocked(FeedCommands.reloadPost).mockResolvedValueOnce({video: fresh} as never);
		render({...VIDEO, expires_at: soon()});
		await play();
		expect(FeedCommands.reloadPost).toHaveBeenCalledExactlyOnceWith(POST_ID);
		expect(hls.instances[0]!.loadSource).toHaveBeenCalledWith(fresh.hls_url);
	});

	// The segments of a long video are fetched as it plays, with the URLs taken at the start.
	it('gets fresh URLs first when the video is longer than the time its URLs have left', async () => {
		vi.mocked(FeedCommands.reloadPost).mockResolvedValueOnce(null);
		render({...VIDEO, duration: 3600, expires_at: new Date(Date.now() + 30 * 60_000).toISOString()});
		await play();
		expect(FeedCommands.reloadPost).toHaveBeenCalledExactlyOnceWith(POST_ID);
		expect(hls.instances[0]!.loadSource).toHaveBeenCalledWith(VIDEO.hls_url);
	});

	it('reloads the post once when its poster fails to load with URLs about to run out', () => {
		vi.mocked(FeedCommands.reloadPost).mockResolvedValue(null);
		render();
		const poster = () => container.querySelector('img')!;
		// A poster that fails with URLs good for hours is not an expiry: no reload.
		act(() => {
			poster().dispatchEvent(new Event('error'));
		});
		expect(FeedCommands.reloadPost).not.toHaveBeenCalled();
		render({...VIDEO, expires_at: soon()});
		act(() => {
			poster().dispatchEvent(new Event('error'));
			poster().dispatchEvent(new Event('error'));
		});
		expect(FeedCommands.reloadPost).toHaveBeenCalledExactlyOnceWith(POST_ID);
	});

	it('falls back to MP4 when neither native HLS nor hls.js works', async () => {
		hls.supported = false;
		render();
		await play();
		expect(playerProps()).toMatchObject({src: VIDEO.mp4_url, autoPlay: true});
		expect(hls.instances).toHaveLength(0);
	});

	it('says the video cannot be played when there is no MP4 either', async () => {
		hls.supported = false;
		render({...VIDEO, mp4_url: null});
		await play();
		expect(container.textContent).toContain("This video can't be played in this browser.");
		expect(VideoPlayer).not.toHaveBeenCalled();
		expect(container.querySelector('video')).toBeNull();
	});

	it('destroys the hls.js instance on unmount and on a fatal error', async () => {
		render();
		await play();
		const [first] = hls.instances;
		act(() => root.unmount());
		expect(first!.destroy).toHaveBeenCalledTimes(1);

		root = createRoot(container);
		render();
		await play();
		const second = hls.instances[1]!;
		const onError = second.handlers.get('hlsError')!;
		act(() => onError('hlsError', {fatal: false}));
		expect(second.destroy).not.toHaveBeenCalled();
		act(() => onError('hlsError', {fatal: true}));
		expect(second.destroy).toHaveBeenCalledTimes(1);
		expect(container.querySelector('video')).toBeNull();
		expect(container.textContent).toContain("Couldn't play this video.");
	});
});
