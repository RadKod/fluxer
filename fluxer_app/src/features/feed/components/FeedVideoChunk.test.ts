// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';
// The production build's chunk split (rspack.config.mjs is the app's own build file, not a module of the app).
import createConfig from '../../../../rspack.config.mjs';

interface CacheGroup {
	test: RegExp | ((module: {resource?: string}) => boolean);
	priority: number;
	enforce?: boolean;
	chunks?: (chunk: {canBeInitial: () => boolean; name?: string; runtime?: string}) => boolean;
}

const cacheGroups = (createConfig() as {optimization: {splitChunks: {cacheGroups: Record<string, CacheGroup>}}})
	.optimization.splitChunks.cacheGroups;
const HLS_MODULE = '/app/node_modules/.pnpm/hls.js@1.7.3/node_modules/hls.js/dist/hls.light.mjs';
const OTHER_MODULE = '/app/node_modules/.pnpm/luxon@3.7.2/node_modules/luxon/src/luxon.js';

const matches = (group: CacheGroup, resource: string) =>
	typeof group.test === 'function' ? group.test({resource}) : group.test.test(resource);

// FeedVideo imports hls.js on the first play; it must stay out of the chunks every page loads.
describe('the feed video player chunk', () => {
	it('keeps hls.js out of the vendor chunk loaded at start', () => {
		expect(matches(cacheGroups.vendor!, HLS_MODULE)).toBe(false);
		expect(matches(cacheGroups.vendor!, OTHER_MODULE)).toBe(true);
	});

	it('puts hls.js in a chunk of its own that only an async import loads', () => {
		const hls = cacheGroups.hls!;
		expect(matches(hls, HLS_MODULE)).toBe(true);
		expect(matches(hls, OTHER_MODULE)).toBe(false);
		expect(hls.priority).toBeGreaterThan(cacheGroups.vendor!.priority);
		expect(hls.enforce).toBe(true);
		expect(hls.chunks!({canBeInitial: () => false, runtime: 'main'})).toBe(true);
		expect(hls.chunks!({canBeInitial: () => true, name: 'main', runtime: 'main'})).toBe(false);
	});
});
