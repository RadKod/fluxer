// SPDX-License-Identifier: AGPL-3.0-or-later

// The sample keys of the v1 set on sanalyer.com (manifest.json from dogaclama-paketle.py), for tests that check
// every lane note can be played from a sample within the detune limit.

import type {JamSampleGroup} from '@app/features/activities/band/jam/JamAssets';

export const JAM_V1_SAMPLE_KEYS: Readonly<Record<Exclude<JamSampleGroup, 'davul'>, ReadonlyArray<number>>> = {
	bas: [25, 28, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60],
	gitar_guc: [40, 42, 45, 48, 51, 54, 57],
	gitar_temiz: [40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75],
	klavye: [45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81],
	gitar_di: [37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84, 86],
};

export const JAM_V1_DRUM_KEYS: ReadonlyArray<string> = [
	'crash',
	'hh_acik',
	'hh_kapali',
	'kick',
	'ride',
	'snare',
	'tom_ince',
	'tom_kalin',
];
