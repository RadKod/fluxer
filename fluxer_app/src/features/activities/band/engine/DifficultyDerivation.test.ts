// SPDX-License-Identifier: AGPL-3.0-or-later

import {noteGroup, partChart} from '@app/features/activities/band/engine/BandTestFixtures';
import {DrumLane, FretLane, type NoteGroup, type PartChart} from '@app/features/activities/band/engine/ChartModel';
import {
	DRUM_DERIVATION_RULES,
	deriveDifficulty,
	FRET_DERIVATION_RULES,
} from '@app/features/activities/band/engine/DifficultyDerivation';
import {TempoMap} from '@app/features/activities/band/engine/TempoMap';
import {describe, expect, it} from 'vitest';

const RES = 480;
const SIXTEENTH = RES / 4;
const MEASURE = RES * 4;

function at(map: TempoMap, tick: number, lanes: ReadonlyArray<number>, overrides: Partial<NoteGroup> = {}): NoteGroup {
	return noteGroup(map.tickToMs(tick), lanes, {tick, ...overrides});
}

function gaps(chart: PartChart): Array<number> {
	return chart.groups.slice(1).map((group, i) => group.msTime - chart.groups[i].msTime);
}

// Eight bars of sixteenths at 120 BPM sweeping green..orange and back.
const SWEEP = [0, 1, 2, 3, 4, 3, 2, 1];
const map120 = new TempoMap(RES, [{tick: 0, beatsPerMinute: 120}], []);
// Short fixtures run at 60 BPM so the notes-per-second floor, not the density ceiling, sets the note budget.
const map60 = new TempoMap(RES, [{tick: 0, beatsPerMinute: 60}], []);
const sixteenthRun = partChart(
	Array.from({length: 128}, (_, i) => at(map120, i * SIXTEENTH, [SWEEP[i % SWEEP.length]])),
);

describe('deriveDifficulty for fret parts', () => {
	it('keeps Easy on beats, three lanes, single notes, spaced by its minimum gap', () => {
		const easy = deriveDifficulty(sixteenthRun, 'easy', map120);
		expect(easy).toMatchObject({derived: true, difficulty: 'easy', part: 'guitar'});
		expect(easy.groups).toHaveLength(32);
		expect(easy.groups.every((group) => group.tick % RES === 0)).toBe(true);
		expect(easy.groups.every((group) => group.lanes.length === 1 && group.lanes[0] <= FretLane.Yellow)).toBe(true);
		expect(Math.min(...gaps(easy))).toBeGreaterThanOrEqual(FRET_DERIVATION_RULES.easy.minGapMs);
	});

	it('keeps Medium on eighths and four lanes', () => {
		const medium = deriveDifficulty(sixteenthRun, 'medium', map120);
		expect(medium.groups).toHaveLength(64);
		expect(medium.groups.every((group) => group.tick % (RES / 2) === 0)).toBe(true);
		expect(medium.groups.every((group) => group.lanes.every((lane) => lane <= FretLane.Blue))).toBe(true);
	});

	it('caps Hard at its density ceiling, filling sixteenths evenly', () => {
		const hard = deriveDifficulty(sixteenthRun, 'hard', map120);
		expect(hard.groups).toHaveLength(Math.round(FRET_DERIVATION_RULES.hard.densityCeiling * 128));
		const sixteenthsKept = hard.groups.filter((group) => group.tick % (RES / 2) !== 0);
		const firstHalf = sixteenthsKept.filter((group) => group.tick < 4 * MEASURE).length;
		expect(Math.abs(firstHalf - (sixteenthsKept.length - firstHalf))).toBeLessThanOrEqual(1);
		expect(new Set(hard.groups.flatMap((group) => group.lanes))).toEqual(new Set([0, 1, 2, 3, 4]));
	});

	it('never reverses the direction of a move inside a measure', () => {
		for (const target of ['easy', 'medium', 'hard'] as const) {
			const derived = deriveDifficulty(sixteenthRun, target, map120);
			const expertLane = new Map(sixteenthRun.groups.map((group) => [group.tick, group.lanes[0]]));
			derived.groups.forEach((group, i) => {
				const previous = derived.groups[i - 1];
				if (!previous || map120.measureIndexAt(previous.tick) !== map120.measureIndexAt(group.tick)) return;
				const expertMove = expertLane.get(group.tick)! - expertLane.get(previous.tick)!;
				const derivedMove = group.lanes[0] - previous.lanes[0];
				expect(Math.sign(expertMove) * Math.sign(derivedMove)).toBeGreaterThanOrEqual(0);
			});
		}
	});

	it('shifts a measure that fits instead of squeezing it, keeping the riff shape', () => {
		const high = partChart([0, 1, 2, 3].map((beat) => at(map60, beat * RES, [[2, 3, 4, 3][beat]])));
		expect(deriveDifficulty(high, 'easy', map60).groups.map((group) => group.lanes[0])).toEqual([0, 1, 2, 1]);
	});

	it('keeps the outer notes of chords and drops chords on Easy', () => {
		const chords = partChart([at(map60, 0, [0, 2, 4]), at(map60, RES, [1, 2, 3])]);
		expect(deriveDifficulty(chords, 'hard', map60).groups.map((group) => group.lanes)).toEqual([
			[0, 4],
			[1, 3],
		]);
		expect(deriveDifficulty(chords, 'easy', map60).groups.map((group) => group.lanes)).toEqual([[0], [1]]);
	});

	it('turns open notes green below Hard', () => {
		const opens = partChart([at(map60, 0, [FretLane.Open]), at(map60, RES, [FretLane.Red])]);
		expect(deriveDifficulty(opens, 'hard', map60).groups[0].lanes).toEqual([FretLane.Open]);
		expect(deriveDifficulty(opens, 'medium', map60).groups[0].lanes).toEqual([FretLane.Green]);
	});

	it('does not over-thin a sparse ballad', () => {
		const ballad = partChart(Array.from({length: 40}, (_, i) => at(map60, i * RES, [i % 3])));
		expect(deriveDifficulty(ballad, 'easy', map60).groups).toHaveLength(40);
	});

	it('keeps a note in every star power phrase', () => {
		const offGridTick = 4 * RES + 37;
		const phrase = {tick: offGridTick - 10, length: 20, msTime: 0, msLength: 0};
		const expert = partChart(
			[
				...Array.from({length: 8}, (_, i) => at(map120, i * RES, [0])),
				at(map120, offGridTick, [2], {inStarPower: true}),
			].sort((a, b) => a.tick - b.tick),
			'guitar',
			'expert',
			{starPower: [phrase]},
		);
		const easy = deriveDifficulty(expert, 'easy', map120);
		expect(easy.groups.some((group) => group.tick === offGridTick && group.inStarPower)).toBe(true);
		expect(easy.starPower).toEqual([phrase]);
	});

	it('only marks HOPOs that still follow their Expert neighbour', () => {
		const expert = partChart([
			at(map60, 0, [0]),
			at(map60, 37, [1], {isHopo: true}),
			at(map60, RES, [2], {isHopo: true}),
			at(map60, RES + 240, [3], {isHopo: true}),
			at(map60, MEASURE, [0]),
		]);
		const medium = deriveDifficulty(expert, 'medium', map60);
		expect(medium.groups.map((group) => [group.tick, group.isHopo])).toEqual([
			[0, false],
			[RES, false],
			[RES + 240, true],
			[MEASURE, false],
		]);
		expect(deriveDifficulty(expert, 'easy', map60).groups.every((group) => !group.isHopo)).toBe(true);
	});

	it('is deterministic', () => {
		expect(deriveDifficulty(sixteenthRun, 'medium', map120)).toEqual(deriveDifficulty(sixteenthRun, 'medium', map120));
	});
});

describe('deriveDifficulty for drums', () => {
	const kick = DrumLane.Kick;
	const drums = partChart(
		Array.from({length: 32}, (_, i) =>
			at(
				map120,
				i * (RES / 2),
				i % 2 === 0 ? [kick, DrumLane.Red, DrumLane.Yellow, DrumLane.Blue] : [DrumLane.Yellow],
				{
					cymbals: [DrumLane.Yellow],
				},
			),
		),
		'drums',
	);

	it('keeps kicks only on downbeats on Easy and on beats on Medium', () => {
		const kicks = partChart(
			Array.from({length: 32}, (_, i) => at(map120, i * (RES / 2), [kick])),
			'drums',
		);
		const easy = deriveDifficulty(kicks, 'easy', map120);
		const medium = deriveDifficulty(kicks, 'medium', map120);
		const kickTicks = (chart: PartChart) =>
			chart.groups.filter((group) => group.lanes.includes(kick)).map((group) => group.tick);
		expect(kickTicks(easy).every((tick) => tick % MEASURE === 0)).toBe(true);
		expect(kickTicks(medium).every((tick) => tick % RES === 0)).toBe(true);
		expect(kickTicks(medium).some((tick) => tick % MEASURE !== 0)).toBe(true);
	});

	it('limits chord size, preferring snare and cymbals over toms', () => {
		const easy = deriveDifficulty(drums, 'easy', map120);
		expect(easy.groups.every((group) => group.lanes.length <= DRUM_DERIVATION_RULES.easy.maxChordSize)).toBe(true);
		const downbeat = easy.groups.find((group) => group.tick === 0)!;
		expect(downbeat.lanes).toEqual([DrumLane.Red, DrumLane.Yellow]);
		expect(downbeat.cymbals).toEqual([DrumLane.Yellow]);

		const hard = deriveDifficulty(drums, 'hard', map120);
		expect(hard.groups[0].lanes).toEqual([kick, DrumLane.Red, DrumLane.Yellow]);
	});
});
