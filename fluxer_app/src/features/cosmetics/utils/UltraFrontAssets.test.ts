// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {loadFrontIdle, preloadFrontFrames} from '@app/features/cosmetics/utils/UltraFrontAssets';
import * as ImageCacheUtils from '@app/features/messaging/utils/ImageCacheUtils';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The image cache keeps a decoded copy of each loaded frame in a second Image (served from the browser cache, not the
// network); counting it would double every load these tests count.
vi.mock('@app/features/messaging/utils/ImageRetention', () => ({retainImage: () => {}}));
const created: Array<string> = [];
const failing = new Set<string>();

// Loads on the next microtask; a URL in `failing` errors instead.
class FakeImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	decoding = '';
	complete = false;
	naturalWidth = 0;
	naturalHeight = 0;
	currentSrc = '';
	private url = '';
	set src(value: string) {
		this.url = value;
		created.push(value);
		queueMicrotask(() => {
			if (failing.has(value)) {
				this.onerror?.();
				return;
			}
			this.complete = true;
			this.naturalWidth = 288;
			this.naturalHeight = 576;
			this.onload?.();
		});
	}
	get src() {
		return this.url;
	}
}

const fetchSpy = vi.fn(async (url: string) => new Response(new Blob([url]), {status: 200}));

// The caches live for the whole session, so every case uses URLs no other case has seen.
describe('UltraFrontAssets', () => {
	beforeEach(() => {
		created.length = 0;
		failing.clear();
		fetchSpy.mockClear();
		vi.stubGlobal('Image', FakeImage);
		vi.stubGlobal('fetch', fetchSpy);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("loads every frame of a list once through Fluxer's image cache, however often it is asked", async () => {
		await preloadFrontFrames(['u/0', 'u/1']);
		await preloadFrontFrames(['u/0', 'u/1']);
		expect(created).toEqual(['u/0', 'u/1']);
		expect(ImageCacheUtils.hasImage('u/0')).toBe(true);
		expect(ImageCacheUtils.hasImage('u/1')).toBe(true);
	});

	it("asks a failed frame again once Fluxer's image cache has cooled it down", async () => {
		vi.useFakeTimers();
		failing.add('u/bad-1');
		const first = preloadFrontFrames(['u/bad-0', 'u/bad-1']);
		const failed = expect(first).rejects.toThrow();
		// Two retries of at most 3 s and 9 s, then the failure.
		await vi.advanceTimersByTimeAsync(15_000);
		await failed;
		failing.clear();
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(preloadFrontFrames(['u/bad-0', 'u/bad-1'])).resolves.toBeUndefined();
		expect(created.filter((url) => url === 'u/bad-0')).toEqual(['u/bad-0']);
	});

	it('downloads a loop once per URL and hands out the same blob', async () => {
		const first = await loadFrontIdle('u/idle');
		const second = await loadFrontIdle('u/idle');
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});

	it('does not ask again after a failed download in the same session', async () => {
		fetchSpy.mockResolvedValueOnce(new Response(null, {status: 500}));
		await expect(loadFrontIdle('u/bad')).rejects.toThrow();
		await expect(loadFrontIdle('u/bad')).rejects.toThrow();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('keeps at most eight loops and forgets the least recently used', async () => {
		for (let i = 0; i < 9; i++) await loadFrontIdle(`u/lru-${i}`);
		await loadFrontIdle('u/lru-8'); // still cached
		await loadFrontIdle('u/lru-0'); // evicted by the ninth → asked again
		expect(fetchSpy).toHaveBeenCalledTimes(10);
	});
});
