// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it} from 'vitest';

const configUrl = new URL('../../../../rspack.config.mjs', import.meta.url).href;
const {default: createConfig} = await import(/* @vite-ignore */ configUrl);
const groups = createConfig().optimization.splitChunks.cacheGroups;

describe('TTS chunk boundaries', () => {
	it.each([
		'/app/node_modules/mespeak/mespeak.js',
		'/app/node_modules/.pnpm/mespeak@2.0.2/node_modules/mespeak/src/mespeak_config.json',
		'/app/node_modules/mespeak/voices/en/en-us.json',
		'C:\\app\\node_modules\\mespeak\\voices\\tr.json',
		'C:\\app\\node_modules\\.pnpm\\mespeak@2.0.2\\node_modules\\mespeak\\voices\\fr.json',
	])('keeps %s outside the initial vendor group', (resource) => {
		expect(groups.vendor.test({resource})).toBe(false);
	});

	it.each([
		'/app/node_modules/mespeak/mespeak.js',
		'/app/node_modules/.pnpm/mespeak@2.0.2/node_modules/mespeak/src/mespeak_config.json',
		'C:\\app\\node_modules\\mespeak\\mespeak.js',
	])('keeps the engine and config %s in the lazy TTS group', (resource) => {
		expect(groups.tts.test.test(resource)).toBe(true);
	});

	it('preserves ordinary vendor matching and does not group every voice into one named chunk', () => {
		expect(groups.vendor.test({resource: '/app/node_modules/mobx/dist/mobx.js'})).toBe(true);
		expect(groups.vendor.test({resource: '/app/src/mespeak.ts'})).toBe(false);
		for (const resource of [
			'/app/node_modules/mespeak/voices/tr.json',
			'/app/node_modules/.pnpm/mespeak@2.0.2/node_modules/mespeak/voices/en/en-us.json',
			'C:\\app\\node_modules\\mespeak\\voices\\fr.json',
		]) {
			const voiceModule = {resource};
			for (const group of Object.values(groups) as Array<{name?: string; test?: unknown}>) {
				if (group.name && typeof group.test === 'function') {
					expect(group.test(voiceModule)).toBe(false);
				} else if (group.name && group.test instanceof RegExp) {
					expect(group.test.test(voiceModule.resource)).toBe(false);
				}
			}
		}
	});
});
