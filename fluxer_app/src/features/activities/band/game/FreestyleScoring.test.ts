// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SoloCue, SoloSection} from '@app/features/activities/band/engine/FreestyleSolo';
import {NOTE_POINTS, SUSTAIN_POINTS_PER_SECOND} from '@app/features/activities/band/engine/Judge';
import {
	cuePressBudget,
	FREESTYLE_SCORING,
	FreestyleScorer,
	followsCue,
} from '@app/features/activities/band/game/FreestyleScoring';
import {describe, expect, it} from 'vitest';

function cue(style: SoloCue['style'], region: SoloCue['region'], startMs = 0, endMs = 2_000, notes = 8): SoloCue {
	return {startMs, endMs, style, region, notes};
}

function section(cues: ReadonlyArray<SoloCue>): SoloSection {
	return {startMs: cues[0].startMs, endMs: cues.at(-1)?.endMs ?? 0, firstIndex: 0, endIndex: 0, cues};
}

describe('following a freestyle cue', () => {
	it('wants the band of lanes it shows: blue the right-hand keys, orange the left-hand ones', () => {
		expect([0, 1, 2, 3, 4].map((lane) => followsCue(cue('free', null), lane, null, 100))).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
		expect([0, 1, 2, 3, 4].map((lane) => followsCue(cue('sustain', 'high'), lane, null, 100))).toEqual([
			false,
			false,
			true,
			true,
			true,
		]);
		expect([0, 1, 2, 3, 4].map((lane) => followsCue(cue('sustain', 'low'), lane, null, 100))).toEqual([
			true,
			true,
			true,
			false,
			false,
		]);
	});

	it('counts a strum cue only while the presses keep coming fast', () => {
		const strum = cue('strum', 'low', 1_000);
		expect(followsCue(strum, 0, {lane: 4, ms: 500}, 1_050)).toBe(true);
		expect(followsCue(strum, 1, {lane: 0, ms: 1_050}, 1_050 + FREESTYLE_SCORING.strumGapMs)).toBe(true);
		expect(followsCue(strum, 1, {lane: 0, ms: 1_050}, 1_051 + FREESTYLE_SCORING.strumGapMs)).toBe(false);
	});

	it('counts a tap cue for quick presses that alternate keys', () => {
		const tap = cue('tap', 'high', 1_000);
		expect(followsCue(tap, 3, {lane: 4, ms: 1_100}, 1_200)).toBe(true);
		expect(followsCue(tap, 4, {lane: 4, ms: 1_100}, 1_200)).toBe(false);
		expect(followsCue(tap, 3, {lane: 4, ms: 1_100}, 1_400)).toBe(false);
	});
});

describe('FreestyleScorer', () => {
	it('pays a following press like a note at the streak multiplier and difficulty, and an off-cue one nothing', () => {
		const scorer = new FreestyleScorer('expert');
		const solo = section([cue('free', null, 0, 1_000), cue('sustain', 'high', 1_000, 2_000)]);
		expect(scorer.press(solo, 0, 100, 2)).toEqual({following: true, counted: true, points: NOTE_POINTS * 2 * 2});
		expect(scorer.press(solo, 0, 1_100, 2)).toEqual({following: false, counted: false, points: 0});
		expect(scorer.press(solo, 4, 2_100, 2)).toEqual({following: false, counted: false, points: 0});
	});

	it('stops paying a cue once it has had about as many presses as the chart has notes', () => {
		const scorer = new FreestyleScorer('easy');
		const free = cue('free', null, 0, 10_000, 4);
		const solo = section([free]);
		const budget = cuePressBudget(free);
		expect(budget).toBe(8);
		const presses = Array.from({length: budget + 3}, (_, i) => scorer.press(solo, i % 5, i * 300, 1));
		expect(presses.filter((press) => press.counted)).toHaveLength(budget);
		expect(presses.at(-1)).toEqual({following: true, counted: false, points: 0});
	});

	it('pays a note held in the band through a sustain cue, and nothing outside one', () => {
		const scorer = new FreestyleScorer('expert');
		const solo = section([cue('strum', 'low', 0, 1_000), cue('sustain', 'high', 1_000, 3_000)]);
		expect(scorer.sustainPoints(solo, new Set([3]), 500, 1_500, 1)).toBeCloseTo((SUSTAIN_POINTS_PER_SECOND / 2) * 2);
		expect(scorer.sustainPoints(solo, new Set([0]), 1_000, 2_000, 1)).toBe(0);
		expect(scorer.sustainPoints(solo, new Set(), 1_000, 2_000, 1)).toBe(0);
	});
});
