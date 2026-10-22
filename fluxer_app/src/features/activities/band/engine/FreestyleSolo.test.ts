// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	buildMidi,
	EXPERT_NOTE_BASE,
	type MidiNoteSpec,
	noteGroup,
	partChart,
} from '@app/features/activities/band/engine/BandTestFixtures';
import {partFinale} from '@app/features/activities/band/engine/BigRockEnding';
import {FretLane, type NoteGroup} from '@app/features/activities/band/engine/ChartModel';
import {
	deriveSoloCues,
	freestyleSections,
	isFreestyleGroup,
	isFreestylePart,
	SOLO_CUE,
	soloCueAt,
	soloSectionAt,
	soloSpans,
} from '@app/features/activities/band/engine/FreestyleSolo';
import {SongChart} from '@app/features/activities/band/engine/SongChart';
import {describe, expect, it} from 'vitest';

// 120 BPM: a beat is 480 ticks and 500 ms.
const BEAT = 480;
const SOLO_MARKER = 103;
const GREEN = EXPERT_NOTE_BASE + FretLane.Green;

function beats(from: number, count: number, note = GREEN): Array<MidiNoteSpec> {
	return Array.from({length: count}, (_, i) => ({tick: (from + i) * BEAT, note}));
}

describe('solo sections', () => {
	it('takes the solo markers of a .mid part (note 103)', () => {
		const chart = SongChart.parse(
			buildMidi({
				tracks: [
					{
						name: 'PART GUITAR',
						notes: [...beats(0, 16), {tick: 4 * BEAT, note: SOLO_MARKER, length: 8 * BEAT}],
					},
				],
			}),
			'mid',
		);
		const guitar = chart.partChart('guitar', 'expert');
		if (!guitar) throw new Error('no guitar');
		const sections = freestyleSections(guitar, chart.sections);
		expect(sections).toHaveLength(1);
		expect(sections[0]).toMatchObject({startMs: 2_000, endMs: 6_000, firstIndex: 4, endIndex: 12});
		expect(isFreestyleGroup(sections, 3)).toBe(false);
		expect(isFreestyleGroup(sections, 4)).toBe(true);
		expect(isFreestyleGroup(sections, 12)).toBe(false);
	});

	it('falls back to EVENTS sections named solo for the lead guitar only', () => {
		const chart = SongChart.parse(
			buildMidi({
				tracks: [
					{name: 'PART GUITAR', notes: beats(0, 20)},
					{name: 'PART KEYS', notes: beats(0, 20)},
					{
						name: 'EVENTS',
						texts: [
							{tick: 0, text: '[section intro]'},
							{tick: 4 * BEAT, text: '[section guitar_solo_1]'},
							{tick: 8 * BEAT, text: '[section Guitar Solo 2]'},
							{tick: 12 * BEAT, text: '[section verse]'},
						],
					},
				],
			}),
			'mid',
		);
		const guitar = chart.partChart('guitar', 'expert');
		const keys = chart.partChart('keys', 'expert');
		if (!guitar || !keys) throw new Error('no parts');
		expect(soloSpans(guitar, chart.sections)).toEqual([{startMs: 2_000, endMs: 6_000}]);
		expect(soloSpans(keys, chart.sections)).toEqual([]);
	});

	it('skips a marker over too few notes and stops a solo where the Big Rock Ending starts', () => {
		const groups = Array.from({length: 20}, (_, i) => noteGroup(i * 500, [FretLane.Green]));
		const span = (startMs: number, endMs: number) => ({
			tick: startMs,
			length: endMs - startMs,
			msTime: startMs,
			msLength: endMs - startMs,
		});
		const chart = partChart(groups, 'guitar', 'expert', {solos: [span(1_000, 2_000), span(5_000, 9_000)]});
		const finale = partFinale(span(7_000, 9_500), groups);
		const sections = freestyleSections(chart, [], finale);
		expect(sections.map(({startMs, endMs, firstIndex, endIndex}) => ({startMs, endMs, firstIndex, endIndex}))).toEqual([
			{startMs: 5_000, endMs: 7_000, firstIndex: 10, endIndex: 14},
		]);
	});

	it('offers freestyle to the guitars and keys, not to bass, drums or vocals', () => {
		expect(
			['guitar', 'rhythm', 'keys', 'bass', 'drums', 'vocals'].map((part) => isFreestylePart(part as never)),
		).toEqual([true, true, true, false, false, false]);
	});
});

function run(fromMs: number, count: number, stepMs: number, lane: number, overrides: Partial<NoteGroup> = {}) {
	return Array.from({length: count}, (_, i) => noteGroup(fromMs + i * stepMs, [lane], overrides));
}

describe('solo cues from the charted notes', () => {
	it('follows the solo: a fast low run, a high held note, a tapped high run, then sparse free notes', () => {
		const groups = [
			...run(0, 12, 100, FretLane.Green),
			noteGroup(1_200, [FretLane.Orange], {msLength: 1_200}),
			...run(2_400, 10, 90, FretLane.Blue, {isTap: true}),
			...run(3_400, 4, 400, FretLane.Yellow),
		];
		const cues = deriveSoloCues(groups, 0, groups.length, 0, 5_000);
		expect(cues.map(({style, region}) => [style, region])).toEqual([
			['strum', 'low'],
			['sustain', 'high'],
			['tap', 'high'],
			['free', null],
		]);
		expect(cues[0]).toMatchObject({startMs: 0, endMs: 1_200, notes: 12});
		expect(cues.at(-1)).toMatchObject({startMs: 3_400, endMs: 5_000, notes: 4});
		for (let i = 1; i < cues.length; i++) expect(cues[i].startMs).toBe(cues[i - 1].endMs);
	});

	it('folds a cue too short to follow into its neighbour', () => {
		const groups = [
			...run(0, 10, 100, FretLane.Green),
			noteGroup(1_000, [FretLane.Orange], {msLength: SOLO_CUE.sustainMs}),
			...run(1_400, 10, 100, FretLane.Green),
		];
		const cues = deriveSoloCues(groups, 0, groups.length, 0, 2_400);
		expect(cues).toEqual([{startMs: 0, endMs: 2_400, style: 'strum', region: 'low', notes: 21}]);
	});

	it('reads chords and open notes by their height, and gives an empty solo one free cue', () => {
		const low = noteGroup(0, [FretLane.Open], {msLength: 900});
		const high = noteGroup(1_000, [FretLane.Yellow, FretLane.Orange], {msLength: 0});
		const cues = deriveSoloCues([low, ...run(1_000, 8, 120, FretLane.Blue), high], 0, 2, 0, 2_000);
		expect(cues.map(({style, region}) => [style, region])).toEqual([
			['sustain', 'low'],
			['free', null],
		]);
		expect(deriveSoloCues([], 0, 0, 0, 1_000)).toEqual([
			{startMs: 0, endMs: 1_000, style: 'free', region: null, notes: 0},
		]);
	});

	it('finds the section and cue under a moment', () => {
		const groups = [...run(0, 12, 100, FretLane.Green), ...run(1_200, 6, 300, FretLane.Blue)];
		const chart = partChart(groups, 'guitar', 'expert', {
			solos: [{tick: 0, length: 3_000, msTime: 0, msLength: 3_000}],
		});
		const sections = freestyleSections(chart, []);
		const section = soloSectionAt(sections, 1_500);
		expect(section?.startMs).toBe(0);
		expect(section && soloCueAt(section, 1_500)?.style).toBe('free');
		expect(soloSectionAt(sections, 3_000)).toBeNull();
	});
});
