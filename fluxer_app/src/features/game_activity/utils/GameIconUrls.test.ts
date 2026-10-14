// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {describe, expect, test, vi} from 'vitest';
import {getGameIconUrl} from './GameIconUrls';

const assetsLoaded = vi.hoisted(() => vi.fn());
vi.mock('./GameIconAssets', () => {
	assetsLoaded();
	return {
		gameIconUrls: {
			'league-of-legends': {
				64: '/assets/league-of-legends-64.hash.webp',
				128: '/assets/league-of-legends-128.hash.webp',
			},
		},
	};
});
vi.mock('@fluxer/game_catalog/src/GameCatalog', () => ({
	getGameById: (id: string) =>
		id === 'league-of-legends' ? {icon: 'league-of-legends'} : id === 'minecraft' ? {icon: null} : undefined,
}));

const wrapperPath = new URL('./GameIconUrls.ts', import.meta.url);

describe('game icon URLs', () => {
	test('does not import assets for unknown or unbundled games', async () => {
		expect(assetsLoaded).not.toHaveBeenCalled();
		expect(await getGameIconUrl('unknown', 64)).toBeNull();
		expect(await getGameIconUrl('minecraft', 128)).toBeNull();
		expect(assetsLoaded).not.toHaveBeenCalled();
	});

	test('lazily returns the bundled URL for the requested size', async () => {
		expect(await getGameIconUrl('league-of-legends', 64)).toBe('/assets/league-of-legends-64.hash.webp');
		expect(await getGameIconUrl('league-of-legends', 128)).toBe('/assets/league-of-legends-128.hash.webp');
		expect(assetsLoaded).toHaveBeenCalledTimes(1);
	});

	test('only loads icon assets through a dynamic import', () => {
		const source = readFileSync(wrapperPath, 'utf8');
		expect(source).toContain("import('./GameIconAssets')");
		expect(source).not.toMatch(/import\s+(?:.+\s+from\s+)?['"].*(?:GameIconAssets|\.webp)['"]/);
		expect(source).not.toMatch(/https?:\/\/|data:/);
	});
});
