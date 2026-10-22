// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	candidateFormats,
	JAM_ASSET_BASE_URL,
	jamAssetUrl,
	parseJamManifest,
} from '@app/features/activities/band/jam/JamAssets';
import {JAM_V1_DRUM_KEYS, JAM_V1_SAMPLE_KEYS} from '@app/features/activities/band/jam/JamTestFixtures';
import {describe, expect, it} from 'vitest';

const MANIFEST = {
	version: 1,
	groups: {...JAM_V1_SAMPLE_KEYS, davul: JAM_V1_DRUM_KEYS},
	formats: {opus: 'opus/{name}.ogg', mp3: 'mp3/{name}.mp3'},
};

describe('JamAssets', () => {
	it('reads the manifest dogaclama-paketle.py writes', () => {
		const manifest = parseJamManifest(MANIFEST);
		expect(manifest.groups.gitar_di).toEqual(JAM_V1_SAMPLE_KEYS.gitar_di);
		expect(manifest.formats).toEqual(MANIFEST.formats);
	});

	it('rejects a manifest with a missing group or bad keys', () => {
		const {gitar_di: _, ...withoutDi} = MANIFEST.groups;
		expect(() => parseJamManifest({...MANIFEST, groups: withoutDi})).toThrow(/gitar_di/);
		expect(() => parseJamManifest({...MANIFEST, groups: {...MANIFEST.groups, bas: ['a2']}})).toThrow(/bas/);
		expect(() => parseJamManifest({...MANIFEST, groups: {...MANIFEST.groups, davul: [1]}})).toThrow(/davul/);
		expect(() => parseJamManifest(null)).toThrow();
	});

	it('tries Opus first where it may play, MP3 always', () => {
		const manifest = parseJamManifest(MANIFEST);
		expect(candidateFormats(manifest, () => 'probably')).toEqual(['opus', 'mp3']);
		expect(candidateFormats(manifest, (mime) => (mime.includes('opus') ? '' : 'maybe'))).toEqual(['mp3']);
		expect(candidateFormats(manifest, null)).toEqual(['opus', 'mp3']);
		expect(candidateFormats(parseJamManifest({...MANIFEST, formats: {mp3: 'mp3/{name}.mp3'}}), () => 'maybe')).toEqual([
			'mp3',
		]);
	});

	it('builds file URLs under the set folder', () => {
		const manifest = parseJamManifest(MANIFEST);
		expect(jamAssetUrl(JAM_ASSET_BASE_URL, manifest, 'opus', 'gitar_di', 57)).toBe(
			'https://sanalyer.com/sarkilar/dogaclama/v1/opus/gitar_di_57.ogg',
		);
		expect(jamAssetUrl('http://127.0.0.1:3101/dogaclama/', manifest, 'mp3', 'davul', 'hh_kapali')).toBe(
			'http://127.0.0.1:3101/dogaclama/mp3/davul_hh_kapali.mp3',
		);
	});
});
