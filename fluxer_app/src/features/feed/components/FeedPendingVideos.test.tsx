// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	useLingui: () => ({
		i18n: {
			_: (descriptor: {message: string}, values: Record<string, unknown> = {}) =>
				descriptor.message.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])),
			locale: 'en-US',
		},
	}),
}));
const stopWatching = vi.hoisted(() => vi.fn());
vi.mock('@app/features/feed/commands/FeedVideoCommands', () => ({
	cancelVideo: vi.fn(async () => 'ok'),
	resumeVideo: vi.fn(async () => 'ok'),
	watchPending: vi.fn(() => stopWatching),
}));
vi.mock('@app/features/feed/components/FeedItemMenu', () => ({toastFeedFailure: vi.fn()}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));

const {FeedPendingVideos} = await import('@app/features/feed/components/FeedPendingVideos');
const {default: PendingVideos} = await import('@app/features/feed/state/FeedPendingVideos');
const FeedVideoCommands = await import('@app/features/feed/commands/FeedVideoCommands');
const {toastFeedFailure} = await import('@app/features/feed/components/FeedItemMenu');

describe('FeedPendingVideos', () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;

	beforeEach(() => {
		(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement('div');
		document.body.append(container);
		root = createRoot(container);
		PendingVideos.reset();
		vi.clearAllMocks();
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:clip');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	});

	const rows = () => Array.from(container.querySelectorAll('li'));
	const render = () => act(() => root.render(createElement(FeedPendingVideos)));

	it('asks the server for your videos while shown and shows nothing while there are none', () => {
		render();
		expect(FeedVideoCommands.watchPending).toHaveBeenCalledTimes(1);
		expect(container.innerHTML).toBe('');
		act(() => root.unmount());
		expect(stopWatching).toHaveBeenCalledTimes(1);
		root = createRoot(container);
	});

	it('shows the sent share with the file name and length, then processing, and a video from elsewhere', () => {
		PendingVideos.handleListed([
			{id: 'other', state: 'scanning', created_at: '2026-09-27T18:00:00.000Z', post_id: null},
		]);
		PendingVideos.handleUploadStarted('mine', new File(['v'], 'ace_bind_a_site.mp4', {type: 'video/mp4'}));
		PendingVideos.handleUploadProgress('mine', 0.649);
		render();
		const [mine, other] = rows();
		expect(mine!.textContent).toContain('ace_bind_a_site.mp4');
		expect(mine!.textContent).toContain('Uploading · 64% · posted when ready');
		expect(mine!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('64');
		const preview = mine!.querySelector('video')!;
		expect(preview.getAttribute('src')).toBe('blob:clip');
		Object.defineProperty(preview, 'duration', {value: 42.4});
		act(() => {
			preview.dispatchEvent(new Event('loadedmetadata'));
		});
		expect(mine!.textContent).toContain('0:42');
		// Not known here: no file name, no share.
		expect(other!.textContent).toContain('Video');
		expect(other!.textContent).toContain('Processing · posted when ready');
		expect(other!.querySelector('[role="progressbar"]')!.hasAttribute('aria-valuenow')).toBe(false);

		act(() => PendingVideos.handleUploaded('mine'));
		expect(rows()[0]!.textContent).toContain('Processing · posted when ready');
		act(() => PendingVideos.handleUploadFailed('mine'));
		expect(rows()[0]!.textContent).toContain('The upload failed');
		expect(rows()[0]!.querySelector('[role="progressbar"]')).toBeNull();
	});

	it('cancels a video with its button and says so when the server refuses', async () => {
		PendingVideos.handleUploadStarted('mine', new File(['v'], 'clip.mp4', {type: 'video/mp4'}));
		render();
		const cancel = container.querySelector('button[aria-label="Cancel video"]') as HTMLButtonElement;
		await act(async () => cancel.click());
		expect(FeedVideoCommands.cancelVideo).toHaveBeenCalledWith('mine');
		expect(toastFeedFailure).not.toHaveBeenCalled();

		vi.mocked(FeedVideoCommands.cancelVideo).mockResolvedValueOnce('failed');
		await act(async () => cancel.click());
		expect(toastFeedFailure).toHaveBeenCalledWith(expect.anything(), 'failed');
	});

	it('offers to resume an upload of this tab that failed, and says so when it cannot', async () => {
		const resume = () => container.querySelector<HTMLButtonElement>('button[aria-label="Resume upload"]');
		PendingVideos.handleUploadStarted('mine', new File(['v'], 'clip.mp4', {type: 'video/mp4'}));
		PendingVideos.handleListed([
			{id: 'other', state: 'uploading', created_at: '2026-09-27T18:00:00.000Z', post_id: null},
		]);
		render();
		expect(resume()).toBeNull();
		act(() => {
			PendingVideos.handleUploadFailed('mine');
			PendingVideos.handleUploadFailed('other');
		});
		// Only the tab that has the file can send the rest.
		expect(rows()[0]!.querySelector('button[aria-label="Resume upload"]')).not.toBeNull();
		expect(rows()[1]!.querySelector('button[aria-label="Resume upload"]')).toBeNull();
		await act(async () => resume()!.click());
		expect(FeedVideoCommands.resumeVideo).toHaveBeenCalledWith('mine');
		expect(toastFeedFailure).not.toHaveBeenCalled();

		vi.mocked(FeedVideoCommands.resumeVideo).mockResolvedValueOnce('failed');
		await act(async () => resume()!.click());
		expect(toastFeedFailure).toHaveBeenCalledWith(expect.anything(), 'failed');
	});
});
