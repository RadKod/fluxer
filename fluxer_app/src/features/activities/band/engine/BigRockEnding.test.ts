// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildMidi, EXPERT_NOTE_BASE} from '@app/features/activities/band/engine/BandTestFixtures';
import {findBigRockEnding} from '@app/features/activities/band/engine/BigRockEnding';
import {DrumLane} from '@app/features/activities/band/engine/ChartModel';
import {SongChart} from '@app/features/activities/band/engine/SongChart';
import {describe, expect, it} from 'vitest';

const KICK = EXPERT_NOTE_BASE;
const FILL = 120;
const BEAT = 480;

// 120 BPM: one beat is 500 ms.
function drumsMidi(
	fills: ReadonlyArray<{tick: number; length: number}>,
	texts: ReadonlyArray<{tick: number; text: string}>,
) {
	const notes = Array.from({length: 32}, (_, i) => ({tick: i * BEAT, note: KICK + DrumLane.Red}));
	return buildMidi({
		tracks: [
			{name: 'PART DRUMS', notes: [...notes, ...fills.map(({tick, length}) => ({tick, note: FILL, length}))]},
			{name: 'EVENTS', texts},
		],
	});
}

describe('Big Rock Ending', () => {
	it('takes the drum fill after the [coda] event', () => {
		const midi = drumsMidi(
			[
				{tick: 4 * BEAT, length: 2 * BEAT},
				{tick: 24 * BEAT, length: 8 * BEAT},
			],
			[
				{tick: 0, text: '[section Intro]'},
				{tick: 24 * BEAT, text: '[coda]'},
			],
		);
		expect(SongChart.parse(midi, 'mid').bigRockEnding).toEqual({startMs: 12_000, endMs: 16_000});
	});

	it('is null when the chart has only activation fills', () => {
		const midi = drumsMidi([{tick: 8 * BEAT, length: 2 * BEAT}], [{tick: 0, text: '[section Intro]'}]);
		expect(SongChart.parse(midi, 'mid').bigRockEnding).toBeNull();
	});

	it('accepts a long final fill without a coda text when the song ends inside it', () => {
		expect(
			findBigRockEnding(
				[
					{msTime: 2_000, msLength: 1_000, isCoda: false},
					{msTime: 60_000, msLength: 6_000, isCoda: false},
				],
				[
					{name: 'Verse', msTime: 0},
					{name: 'Outro', msTime: 58_000},
				],
				67_000,
			),
		).toEqual({startMs: 60_000, endMs: 66_000});
	});

	it('rejects a final fill followed by more charting or before the last section', () => {
		const fill = {msTime: 60_000, msLength: 6_000, isCoda: false};
		expect(findBigRockEnding([fill], [{name: 'Outro', msTime: 58_000}], 80_000)).toBeNull();
		expect(findBigRockEnding([fill], [{name: 'Outro', msTime: 62_000}], 66_000)).toBeNull();
		expect(findBigRockEnding([{...fill, msLength: 1_500}], [], 61_000)).toBeNull();
	});
});
