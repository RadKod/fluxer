// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildMidi, EXPERT_NOTE_BASE, type MidiNoteSpec} from '@app/features/activities/band/engine/BandTestFixtures';
import {isFreePlayGroup, partFinale} from '@app/features/activities/band/engine/BigRockEnding';
import {DrumLane, FretLane, type NoteGroup} from '@app/features/activities/band/engine/ChartModel';
import {SongChart} from '@app/features/activities/band/engine/SongChart';
import {describe, expect, it} from 'vitest';

const BEAT = 480;
const FREESTYLE_LANES = [120, 121, 122, 123, 124];

function lanes(tick: number, length: number): Array<MidiNoteSpec> {
	return FREESTYLE_LANES.map((note) => ({tick, note, length}));
}

// Laid out like a Harmonix chart at 120 BPM (one beat is 500 ms): a drum fill at beat 4, "[coda]" at beat 16, all five
// freestyle lanes on every part from beat 16 to 24, the drums empty under them while the guitar keeps its written
// notes, and one final hit half a beat after the lanes.
function harmonixMidi({coda = true}: {coda?: boolean} = {}): Uint8Array {
	const red = EXPERT_NOTE_BASE + DrumLane.Red;
	const kick = EXPERT_NOTE_BASE + DrumLane.Kick;
	const green = EXPERT_NOTE_BASE + FretLane.Green;
	const yellow = EXPERT_NOTE_BASE + FretLane.Yellow;
	return buildMidi({
		tracks: [
			{
				name: 'PART DRUMS',
				notes: [
					...Array.from({length: 16}, (_, i) => ({tick: i * BEAT, note: red})),
					...lanes(4 * BEAT, 2 * BEAT),
					...lanes(16 * BEAT, 8 * BEAT),
					{tick: 24.5 * BEAT, note: kick},
					{tick: 24.5 * BEAT, note: red},
				],
			},
			{
				name: 'PART GUITAR',
				notes: [
					...Array.from({length: 24}, (_, i) => ({tick: i * BEAT, note: green, length: 120})),
					...lanes(16 * BEAT, 8 * BEAT),
					{tick: 24.5 * BEAT, note: green, length: 4 * BEAT},
					{tick: 24.5 * BEAT, note: yellow, length: 4 * BEAT},
				],
			},
			{
				name: 'EVENTS',
				texts: [{tick: 0, text: '[section Intro]'}, ...(coda ? [{tick: 16 * BEAT, text: '[coda]'}] : [])],
			},
		],
	});
}

function groupsAt(times: ReadonlyArray<number>): Array<NoteGroup> {
	return times.map((beat) => ({
		tick: beat * BEAT,
		msTime: beat * 500,
		msLength: 0,
		lanes: [FretLane.Green],
		cymbals: [],
		isHopo: false,
		isTap: false,
		inStarPower: false,
		inSolo: false,
	}));
}

const LANES_SPAN = {tick: 16 * BEAT, length: 8 * BEAT, msTime: 8_000, msLength: 4_000};

describe('Big Rock Ending', () => {
	const song = SongChart.parse(harmonixMidi(), 'mid');

	it('reads the coda lanes per part, not the drum fills before them', () => {
		expect(song.bigRockEnding).toEqual({startMs: 8_000, endMs: 12_000});
		expect(song.partChart('drums', 'expert')?.bigRockEnding).toEqual(LANES_SPAN);
		expect(song.partChart('guitar', 'expert')?.bigRockEnding).toEqual(LANES_SPAN);
	});

	it('takes the first chord after the lanes as the final hit', () => {
		const guitar = song.partChart('guitar', 'expert')!;
		const finale = partFinale(guitar.bigRockEnding, guitar.groups)!;
		expect(finale).toMatchObject({startMs: 8_000, endMs: 12_000, firstIndex: 16, finalIndex: 24});
		expect(guitar.groups[24]).toMatchObject({msTime: 12_250, lanes: [FretLane.Green, FretLane.Yellow]});
		expect(isFreePlayGroup(finale, 15)).toBe(false);
		expect(isFreePlayGroup(finale, 16)).toBe(true);
		expect(isFreePlayGroup(finale, 23)).toBe(true);
		expect(isFreePlayGroup(finale, 24)).toBe(false);

		// Harmonix leaves the drums empty under the lanes: nothing is free play there but the final hit still counts.
		const drums = song.partChart('drums', 'expert')!;
		expect(partFinale(drums.bigRockEnding, drums.groups)).toMatchObject({firstIndex: 16, finalIndex: 16});
		expect(drums.groups[16]).toMatchObject({msTime: 12_250, lanes: [DrumLane.Kick, DrumLane.Red]});
	});

	it('keeps the lanes on difficulties derived from Expert', () => {
		const easy = song.partChart('guitar', 'easy')!;
		expect(easy.derived).toBe(true);
		expect(easy.bigRockEnding).toEqual(LANES_SPAN);
		const finale = partFinale(easy.bigRockEnding, easy.groups)!;
		expect(easy.groups[finale.finalIndex!].msTime).toBe(12_250);
	});

	it('is absent without a [coda] text, whatever the fills look like', () => {
		const plain = SongChart.parse(harmonixMidi({coda: false}), 'mid');
		expect(plain.bigRockEnding).toBeNull();
		expect(plain.partChart('guitar', 'expert')?.bigRockEnding).toBeNull();
	});

	it('falls back to the last chord under the lanes, or none when the part has stopped', () => {
		expect(partFinale(LANES_SPAN, groupsAt([14, 16, 20]))).toMatchObject({firstIndex: 1, finalIndex: 2});
		expect(partFinale(LANES_SPAN, groupsAt([10, 12]))).toMatchObject({firstIndex: 2, finalIndex: null});
		expect(partFinale(null, groupsAt([10]))).toBeNull();
		expect(isFreePlayGroup(null, 0)).toBe(false);
	});
});
