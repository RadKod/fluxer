// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VocalNote, VocalsChart} from '@app/features/activities/band/engine/VocalsParser';
import {currentPhrase, pitchRange, tubeTop} from '@app/features/activities/band/game/VocalsRenderer';
import {describe, expect, it} from 'vitest';

function note(msTime: number, pitch: number | null, phraseIndex: number): VocalNote {
	return {
		tick: msTime,
		msTime,
		msLength: 200,
		pitch,
		lyric: 'la',
		joinsNext: false,
		isSlide: false,
		isSpoken: pitch === null,
		phraseIndex,
	};
}

const CHART: VocalsChart = {
	notes: [note(0, 50, 0), note(500, 62, 0), note(2_000, null, 1), note(2_500, 56, 1)],
	phrases: [
		{tick: 0, length: 0, msTime: 0, msLength: 800},
		{tick: 0, length: 0, msTime: 2_000, msLength: 800},
	],
	starPower: [],
	durationMs: 2_800,
};

describe('VocalsRenderer', () => {
	it('spans tubes over the pitched notes of the song, high notes on top', () => {
		const range = pitchRange(CHART.notes);
		expect(range).toEqual({min: 50, max: 62});
		expect(tubeTop(62, range)).toBeLessThan(tubeTop(50, range));
		expect(tubeTop(null, range)).toBe((tubeTop(50, range) + tubeTop(62, range)) / 2);
	});

	it('shows the phrase being sung, then the next one', () => {
		expect(currentPhrase(CHART, 300)).toBe(0);
		expect(currentPhrase(CHART, 1_200)).toBe(1);
		expect(currentPhrase(CHART, 5_000)).toBe(-1);
	});
});
