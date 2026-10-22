// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	backingNotesAt,
	humanNoise,
	JAM_BACKING_PATTERNS,
	JAM_BACKING_STYLES,
	stepSeconds,
	stepsPerBar,
} from '@app/features/activities/band/jam/JamBacking';
import {drumPiece, JAM_SCALES, type JamScale} from '@app/features/activities/band/jam/JamScales';
import {JAM_V1_SAMPLE_KEYS} from '@app/features/activities/band/jam/JamTestFixtures';
import {nearestSample} from '@app/features/activities/band/jam/JamVoices';
import {describe, expect, it} from 'vitest';

const A = 9;
const rock = JAM_BACKING_PATTERNS.rock;

function drumsAt(step: number, pattern = rock): ReadonlyArray<string | null> {
	return backingNotesAt(pattern, A, 'minorPentatonic', step)
		.filter((note) => note.instrument === 'drums')
		.map((note) => drumPiece(note.note));
}

describe('JamBacking patterns', () => {
	it('opens the phrase with crash and kick in place of the hi-hat', () => {
		expect(drumsAt(0)).toEqual(['kick', 'crash']);
		expect(drumsAt(16)).toEqual(['kick', 'hh_kapali']);
		expect(drumsAt(4)).toEqual(['snare', 'hh_kapali']);
	});

	it('plays the demo groove: open hi-hat and extra kick on the second bar, a tom fill on the fourth', () => {
		expect(drumsAt(16 + 14)).toEqual(['hh_acik']);
		expect(drumsAt(16 + 8)).toEqual(['kick', 'hh_kapali']);
		expect(drumsAt(48 + 10)).toEqual(['tom_ince']);
		expect(drumsAt(48 + 15)).toEqual(['tom_kalin']);
		expect(drumsAt(64)).toEqual(['kick', 'crash']);
	});

	it('walks the rock bass over A5 A5 C5-D5 G5-E5 with the demo’s octave pops', () => {
		const bass = (step: number) =>
			backingNotesAt(rock, A, 'minorPentatonic', step).find((note) => note.instrument === 'bass')?.note;
		expect([0, 2, 6, 14].map(bass)).toEqual([33, 33, 45, 43]);
		expect([32, 40, 46].map(bass)).toEqual([36, 38, 38]);
		expect([48, 56].map(bass)).toEqual([31, 28]);
		expect(bass(1)).toBeUndefined();
	});

	it('holds each bass note to just short of the next', () => {
		const note = backingNotesAt(rock, A, 'minorPentatonic', 0).find((n) => n.instrument === 'bass');
		expect(note?.lengthS).toBeCloseTo(2 * stepSeconds(rock) * 0.85, 9);
	});

	it('keeps every bass note of every style and key within the bass samples', () => {
		for (const style of JAM_BACKING_STYLES) {
			const pattern = JAM_BACKING_PATTERNS[style];
			const phrase = stepsPerBar(pattern) * pattern.progression.minor.length;
			for (let key = 0; key < 12; key++) {
				for (const scale of Object.keys(JAM_SCALES) as ReadonlyArray<JamScale>) {
					for (let step = 0; step < phrase; step++) {
						for (const note of backingNotesAt(pattern, key, scale, step)) {
							if (note.instrument !== 'bass') continue;
							expect(Math.abs(nearestSample(JAM_V1_SAMPLE_KEYS.bas, note.note).detune)).toBeLessThanOrEqual(1.5);
						}
					}
				}
			}
		}
	});

	it('runs a 12-bar shuffle for the slow blues and the major progression for major keys', () => {
		const blues = JAM_BACKING_PATTERNS.slowBlues;
		expect(stepsPerBar(blues)).toBe(12);
		expect(blues.progression.minor).toHaveLength(12);
		expect(stepSeconds(blues)).toBeCloseTo(60 / 66 / 3, 9);
		const punkBass = (step: number) =>
			backingNotesAt(JAM_BACKING_PATTERNS.punk, 0, 'majorPentatonic', step).find((n) => n.instrument === 'bass')?.note;
		// C: I V vi IV
		expect([0, 8, 16, 24].map(punkBass)).toEqual([36, 31, 33, 29]);
	});

	it('humanises deterministically within ±1', () => {
		expect(humanNoise(5, 1)).toBe(humanNoise(5, 1));
		expect(humanNoise(5, 1)).not.toBe(humanNoise(6, 1));
		for (let i = 0; i < 1000; i++) expect(Math.abs(humanNoise(i, i % 7))).toBeLessThanOrEqual(1);
	});
});
