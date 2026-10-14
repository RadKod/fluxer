// SPDX-License-Identifier: AGPL-3.0-or-later

import * as ImageCacheUtils from '@app/features/messaging/utils/ImageCacheUtils';

// TEMPORARY: at most 8 loops per session (a loop is ≤ 1.5 MB); lower it if memory complaints come in.
const MAX_LOOPS = 8;
const loops = new Map<string, Promise<Blob>>();

// Opening starts only once every frame is in Fluxer's image cache , which loads each URL
// once, retries, and after a failed load tries again once its cool-down is over.
export function preloadFrontFrames(urls: ReadonlyArray<string>): Promise<void> {
	return Promise.all(
		urls.map(
			(url) =>
				new Promise<void>((resolve, reject) => {
					ImageCacheUtils.loadImage(url, resolve, () => reject(new Error(`Ultra frame ${url}`)));
				}),
		),
	).then(() => {});
}

// One download per loop URL; each open plays it from a new blob URL, so it restarts without the network.
// A failure stays cached: no retry storm, the layer falls back to the plain URL.
export function loadFrontIdle(url: string): Promise<Blob> {
	const hit = loops.get(url);
	if (hit) {
		loops.delete(url);
		loops.set(url, hit);
		return hit;
	}
	const loop = fetch(url).then((response) => {
		if (!response.ok) throw new Error(`Ultra loop ${response.status}`);
		return response.blob();
	});
	loops.set(url, loop);
	if (loops.size > MAX_LOOPS) loops.delete(loops.keys().next().value as string);
	return loop;
}
