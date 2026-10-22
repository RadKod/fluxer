// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	availableOctaves,
	drumNote,
	drumPiece,
	foldIntoRange,
	homeRoot,
	JAM_DRUM_PIECES,
	JAM_LANE_COUNT,
	JAM_MAX_DETUNE_SEMITONES,
	JAM_SCALES,
	type JamMelodicInstrument,
	type JamScale,
	laneNotes,
	pinchHarmonicFor,
	playableRange,
	powerChordRoot,
} from '@app/features/activities/band/jam/JamScales';
import {JAM_V1_SAMPLE_KEYS} from '@app/features/activities/band/jam/JamTestFixtures';
import {nearestSample} from '@app/features/activities/band/jam/JamVoices';
import {describe, expect, it} from 'vitest';

const A = 9;
const SCALES = Object.keys(JAM_SCALES) as ReadonlyArray<JamScale>;
const KEYS = Array.from({length: 12}, (_, i) => i);
const INSTRUMENT_SAMPLES: ReadonlyArray<readonly [JamMelodicInstrument, ReadonlyArray<number>]> = [
	['guitar', JAM_V1_SAMPLE_KEYS.gitar_di],
	['guitar', JAM_V1_SAMPLE_KEYS.gitar_temiz],
	['keys', JAM_V1_SAMPLE_KEYS.klavye],
	['bass', JAM_V1_SAMPLE_KEYS.bas],
];

describe('JamScales', () => {
	it('maps A minor pentatonic onto the prototype solo box, bass two octaves down', () => {
		const range = playableRange(JAM_V1_SAMPLE_KEYS.gitar_di);
		expect(laneNotes('guitar', {key: A, scale: 'minorPentatonic', octave: 0}, range)).toEqual([57, 60, 62, 64, 67]);
		expect(laneNotes('guitar', {key: A, scale: 'minorPentatonic', octave: 1}, range)).toEqual([69, 72, 74, 76, 79]);
		expect(laneNotes('guitar', {key: A, scale: 'minorPentatonic', octave: -1}, range)).toEqual([45, 48, 50, 52, 55]);
		expect(
			laneNotes('bass', {key: A, scale: 'minorPentatonic', octave: 0}, playableRange(JAM_V1_SAMPLE_KEYS.bas)),
		).toEqual([33, 36, 38, 40, 43]);
	});

	it('lays out each scale from the root', () => {
		const range = playableRange(JAM_V1_SAMPLE_KEYS.gitar_di);
		const layout = (scale: JamScale) => laneNotes('guitar', {key: 0, scale, octave: 0}, range);
		expect(layout('majorPentatonic')).toEqual([60, 62, 64, 67, 69]);
		expect(layout('blues')).toEqual([60, 63, 65, 66, 67]);
		expect(layout('naturalMinor')).toEqual([60, 62, 63, 65, 67]);
		expect(laneNotes('guitar', {key: 0, scale: 'naturalMinor', octave: 0, position: 3}, range)).toEqual([
			65, 67, 68, 70, 72,
		]);
		expect(laneNotes('guitar', {key: 0, scale: 'blues', octave: 0, position: 4}, range)).toEqual([67, 70, 72, 75, 77]);
	});

	it('keeps the home root of every key inside one octave per instrument', () => {
		for (const key of KEYS) {
			expect(homeRoot('guitar', key) % 12).toBe(key);
			expect(homeRoot('guitar', key)).toBeGreaterThanOrEqual(52);
			expect(homeRoot('guitar', key)).toBeLessThan(64);
			expect(homeRoot('bass', key) % 12).toBe(key);
			expect(homeRoot('bass', key)).toBeGreaterThanOrEqual(24);
			expect(homeRoot('bass', key)).toBeLessThan(36);
		}
	});

	it('plays every lane of every key, scale, position and octave from a sample within the detune limit', () => {
		for (const [instrument, samples] of INSTRUMENT_SAMPLES) {
			const range = playableRange(samples);
			for (const key of KEYS) {
				for (const scale of SCALES) {
					for (let position = 0; position < JAM_SCALES[scale].length; position++) {
						for (const octave of [-2, -1, 0, 1, 2]) {
							const notes = laneNotes(instrument, {key, scale, octave, position}, range);
							expect(notes).toHaveLength(JAM_LANE_COUNT);
							for (const note of notes) {
								expect(Math.abs(nearestSample(samples, note).detune)).toBeLessThanOrEqual(JAM_MAX_DETUNE_SEMITONES);
							}
						}
					}
				}
			}
		}
	});

	it('reaches two octaves on the leads and the bass in the pentatonic scales', () => {
		for (const [instrument, samples] of INSTRUMENT_SAMPLES) {
			for (const key of KEYS) {
				for (const scale of ['minorPentatonic', 'majorPentatonic'] as const) {
					const octaves = availableOctaves(instrument, {key, scale}, playableRange(samples));
					expect(octaves.length, `${instrument} ${samples[0]} key ${key} ${scale}`).toBeGreaterThanOrEqual(2);
				}
			}
		}
	});

	it('moves to the nearest octave that fits when the asked one does not', () => {
		const clean = playableRange(JAM_V1_SAMPLE_KEYS.gitar_temiz);
		// B: home B3 (59); one octave up would end on D6 (86), past the clean samples.
		expect(availableOctaves('guitar', {key: 11, scale: 'minorPentatonic'}, clean)).toEqual([-1, 0]);
		expect(laneNotes('guitar', {key: 11, scale: 'minorPentatonic', octave: 1}, clean)[0]).toBe(59);
	});

	it('folds notes by octaves into a range', () => {
		const range = {low: 38, high: 59};
		expect(foldIntoRange(64, range)).toBe(52);
		expect(foldIntoRange(30, range)).toBe(42);
		expect(foldIntoRange(45, range)).toBe(45);
	});

	it('puts power chord roots an octave under the lane, inside the chord samples', () => {
		const range = playableRange(JAM_V1_SAMPLE_KEYS.gitar_guc);
		expect(powerChordRoot(57, range)).toBe(45);
		for (const note of [52, 57, 62, 67, 72, 74]) {
			const root = powerChordRoot(note, range);
			expect(Math.abs(nearestSample(JAM_V1_SAMPLE_KEYS.gitar_guc, root).detune)).toBeLessThanOrEqual(2);
			expect(Math.abs((root - note) % 12)).toBe(0);
		}
	});

	it('picks a pinch harmonic that lands in the scale', () => {
		expect(pinchHarmonicFor(57, A, 'minorPentatonic')).toBe(3);
		expect(pinchHarmonicFor(62, A, 'minorPentatonic')).toBe(3);
		// E: its twelfth is B and its seventeenth G#, neither in A minor pentatonic; the double octave is.
		expect(pinchHarmonicFor(64, A, 'minorPentatonic')).toBe(4);
		expect(pinchHarmonicFor(64, A, 'naturalMinor')).toBe(3);
		// Eb over A blues: the twelfth is Bb, out; the seventeenth is G, in.
		expect(pinchHarmonicFor(63, A, 'blues')).toBe(5);
	});

	it('maps drum lanes to pieces with their alternates', () => {
		expect([0, 1, 2, 3, 4].map((lane) => drumPiece(drumNote(lane, false)))).toEqual([
			'kick',
			'snare',
			'hh_kapali',
			'tom_ince',
			'crash',
		]);
		expect([2, 3, 4].map((lane) => drumPiece(drumNote(lane, true)))).toEqual(['hh_acik', 'tom_kalin', 'ride']);
		expect(drumPiece(JAM_DRUM_PIECES.length)).toBeNull();
		expect(() => drumNote(5, false)).toThrow(RangeError);
	});
});
