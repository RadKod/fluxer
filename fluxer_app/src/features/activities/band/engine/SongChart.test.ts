// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildMidi, EXPERT_NOTE_BASE} from '@app/features/activities/band/engine/BandTestFixtures';
import {DrumLane, FretLane} from '@app/features/activities/band/engine/ChartModel';
import {SongChart} from '@app/features/activities/band/engine/SongChart';
import {describe, expect, it} from 'vitest';

const GREEN = EXPERT_NOTE_BASE;
const KICK = EXPERT_NOTE_BASE;
const YELLOW_TOM_MARKER = 110;
const STAR_POWER = 116;
const SOLO = 103;
const HARD_OFFSET = -12;

// 120 BPM at 480 ticks per beat: one beat is 500 ms.
const MIDI = buildMidi({
	tracks: [
		{
			name: 'PART GUITAR',
			notes: [
				{tick: 0, note: GREEN},
				{tick: 480, note: GREEN + FretLane.Red},
				{tick: 480, note: GREEN + FretLane.Yellow},
				{tick: 960, note: GREEN + FretLane.Blue, length: 960},
				{tick: 2400, note: GREEN + FretLane.Orange},
				{tick: 0, note: GREEN + HARD_OFFSET},
				{tick: 0, note: STAR_POWER, length: 900},
				{tick: 2000, note: SOLO, length: 600},
			],
		},
		{name: 'PART RHYTHM', notes: [{tick: 480, note: GREEN + FretLane.Blue}]},
		{
			name: 'PART DRUMS',
			notes: [
				{tick: 0, note: KICK},
				{tick: 0, note: KICK + DrumLane.Yellow},
				{tick: 480, note: KICK + DrumLane.Red},
				{tick: 480, note: KICK + DrumLane.Yellow},
				{tick: 480, note: YELLOW_TOM_MARKER},
			],
		},
		{name: 'EVENTS', texts: [{tick: 0, text: '[section Intro]'}]},
	],
});

describe('SongChart', () => {
	const chart = SongChart.parse(MIDI, 'mid', {pro_drums: true});

	it('lists parts with charted and playable difficulties', () => {
		expect(chart.availableParts()).toEqual([
			{part: 'guitar', charted: ['hard', 'expert'], playable: ['easy', 'medium', 'hard', 'expert']},
			{part: 'bass', charted: ['expert'], playable: ['easy', 'medium', 'hard', 'expert']},
			{part: 'drums', charted: ['expert'], playable: ['easy', 'medium', 'hard', 'expert']},
		]);
		expect(chart.partChart('keys', 'expert')).toBeNull();
		expect(chart.sections).toEqual([{name: 'Intro', msTime: 0}]);
	});

	it('normalizes fret notes into timed groups with chords, sustains, star power and solos', () => {
		const guitar = chart.partChart('guitar', 'expert')!;
		expect(guitar.derived).toBe(false);
		expect(guitar.groups.map((group) => [group.msTime, group.lanes])).toEqual([
			[0, [FretLane.Green]],
			[500, [FretLane.Red, FretLane.Yellow]],
			[1000, [FretLane.Blue]],
			[2500, [FretLane.Orange]],
		]);
		expect(guitar.groups[2].msLength).toBe(1000);
		expect(guitar.groups[0].msLength).toBe(0);
		expect(guitar.groups.map((group) => group.inStarPower)).toEqual([true, true, false, false]);
		expect(guitar.groups.map((group) => group.inSolo)).toEqual([false, false, false, true]);
		expect(guitar.starPower).toEqual([{tick: 0, length: 900, msTime: 0, msLength: 937.5}]);
		expect(guitar.durationMs).toBe(2500);
	});

	it('uses the rhythm track for bass when the chart has no bass track', () => {
		expect(chart.partChart('bass', 'expert')?.groups.map((group) => group.lanes)).toEqual([[FretLane.Blue]]);
		expect(chart.hasPart('rhythm')).toBe(false);
	});

	it('plays the rhythm track as rhythm guitar when the chart also has bass, deriving lower difficulties', () => {
		const twoGuitars = SongChart.parse(
			buildMidi({
				tracks: [
					{name: 'PART GUITAR', notes: [{tick: 0, note: GREEN}]},
					{name: 'PART BASS', notes: [{tick: 0, note: GREEN + FretLane.Red}]},
					{
						name: 'PART RHYTHM',
						notes: [
							{tick: 0, note: GREEN + FretLane.Yellow},
							{tick: 480, note: GREEN + FretLane.Blue},
						],
					},
				],
			}),
			'mid',
		);
		expect(twoGuitars.availableParts()).toEqual([
			{part: 'guitar', charted: ['expert'], playable: ['easy', 'medium', 'hard', 'expert']},
			{part: 'bass', charted: ['expert'], playable: ['easy', 'medium', 'hard', 'expert']},
			{part: 'rhythm', charted: ['expert'], playable: ['easy', 'medium', 'hard', 'expert']},
		]);
		expect(twoGuitars.partChart('bass', 'expert')?.groups.map((group) => group.lanes)).toEqual([[FretLane.Red]]);
		expect(twoGuitars.partChart('rhythm', 'expert')?.groups.map((group) => group.lanes)).toEqual([
			[FretLane.Yellow],
			[FretLane.Blue],
		]);
		expect(twoGuitars.partChart('rhythm', 'easy')).toMatchObject({part: 'rhythm', difficulty: 'easy', derived: true});
	});

	it('reads rhythm guitar from a .chart file', () => {
		const text = [
			'[Song]\n{\n  Resolution = 192\n}',
			'[SyncTrack]\n{\n  0 = TS 4\n  0 = B 120000\n}',
			'[ExpertSingle]\n{\n  0 = N 0 0\n}',
			'[ExpertDoubleBass]\n{\n  0 = N 1 0\n}',
			'[ExpertDoubleRhythm]\n{\n  0 = N 2 0\n  192 = N 3 0\n}',
		].join('\n');
		const fromChart = SongChart.parse(new TextEncoder().encode(text), 'chart');
		expect(fromChart.availableParts().map((availability) => availability.part)).toEqual(['guitar', 'bass', 'rhythm']);
		expect(fromChart.partChart('rhythm', 'expert')?.groups.map((group) => [group.msTime, group.lanes])).toEqual([
			[0, [FretLane.Yellow]],
			[500, [FretLane.Blue]],
		]);
	});

	it('maps drums to kick plus four pads with pro cymbal flags', () => {
		const drums = chart.partChart('drums', 'expert')!;
		expect(drums.groups.map((group) => [group.lanes, group.cymbals])).toEqual([
			[[DrumLane.Kick, DrumLane.Yellow], [DrumLane.Yellow]],
			[[DrumLane.Red, DrumLane.Yellow], []],
		]);
		expect(drums.groups.every((group) => group.msLength === 0 && !group.isHopo)).toBe(true);
	});

	it('serves charted difficulties as-is and derives the missing ones from Expert', () => {
		const hard = chart.partChart('guitar', 'hard')!;
		expect(hard.derived).toBe(false);
		expect(hard.groups).toHaveLength(1);

		const easy = chart.partChart('guitar', 'easy')!;
		expect(easy.derived).toBe(true);
		expect(easy.groups.every((group) => group.lanes.length === 1 && group.lanes[0] <= FretLane.Yellow)).toBe(true);
		expect(chart.partChart('guitar', 'easy')).toBe(easy);
		expect(chart.derivedPartChart('guitar', 'hard')?.derived).toBe(true);
	});

	it('parses .chart files too', () => {
		const text = [
			'[Song]',
			'{',
			'  Resolution = 192',
			'}',
			'[SyncTrack]',
			'{',
			'  0 = TS 4',
			'  0 = B 120000',
			'}',
			'[ExpertSingle]',
			'{',
			'  0 = N 0 0',
			'  192 = N 1 0',
			'  192 = N 2 0',
			'  384 = N 7 0',
			'}',
		].join('\n');
		const parsed = SongChart.parse(new TextEncoder().encode(text), 'chart');
		expect(parsed.vocals).toBeNull();
		expect(parsed.partChart('guitar', 'expert')?.groups.map((group) => [group.msTime, group.lanes])).toEqual([
			[0, [FretLane.Green]],
			[500, [FretLane.Red, FretLane.Yellow]],
			[1000, [FretLane.Open]],
		]);
	});
});
