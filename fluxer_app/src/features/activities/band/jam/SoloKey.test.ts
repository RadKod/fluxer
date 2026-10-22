// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongKey} from '@app/features/activities/band/BandProtocol';
import {laneNotes} from '@app/features/activities/band/jam/JamScales';
import {pitchClass, soloKeyFor} from '@app/features/activities/band/jam/SoloKey';
import {describe, expect, it} from 'vitest';

// Almora's analysis: D minor overall, its guitar solo measured in A minor (blues), a low-confidence song.
const ALMORA: BandSongKey = {
	tonic: 'D',
	mode: 'minor',
	scale: 'minor-pentatonic',
	tuningCents: 14,
	lowConfidence: false,
	solos: [{startMs: 162_512, endMs: 187_250, tonic: 'A', mode: 'minor', scale: 'blues'}],
};

describe('freestyle solo key', () => {
	it('reads sharps and flats as pitch classes', () => {
		expect(['C', 'F#', 'Gb', 'Ab', 'Bb', 'B', 'H'].map(pitchClass)).toEqual([0, 6, 6, 8, 10, 11, null]);
	});

	it('plays the key measured over the solo section, with the song tuning', () => {
		expect(soloKeyFor(ALMORA, 160_000, 188_000)).toEqual({
			key: 9,
			tonic: 'A',
			scale: 'blues',
			tuningCents: 14,
			source: 'solo',
		});
	});

	it('uses the song key for a section the analysis has no solo key for', () => {
		expect(soloKeyFor(ALMORA, 40_000, 60_000)).toEqual({
			key: 2,
			tonic: 'D',
			scale: 'minorPentatonic',
			tuningCents: 14,
			source: 'song',
		});
	});

	it('takes the solo key overlapping the section most', () => {
		const key: BandSongKey = {
			...ALMORA,
			solos: [
				{startMs: 0, endMs: 12_000, tonic: 'E', mode: 'minor', scale: 'minor-pentatonic'},
				{startMs: 12_000, endMs: 30_000, tonic: 'G', mode: 'major', scale: 'major-pentatonic'},
			],
		};
		expect(soloKeyFor(key, 10_000, 30_000)).toMatchObject({key: 7, scale: 'majorPentatonic', source: 'solo'});
	});

	it('stays on the pentatonic of the mode when the analysis is unsure', () => {
		const unsure = {...ALMORA, lowConfidence: true};
		expect(soloKeyFor(unsure, 160_000, 188_000)).toMatchObject({key: 9, scale: 'minorPentatonic', source: 'solo'});
		const major: BandSongKey = {...unsure, tonic: 'Ab', mode: 'major', scale: 'major-pentatonic', solos: []};
		expect(soloKeyFor(major, 0, 1_000)).toMatchObject({key: 8, scale: 'majorPentatonic'});
	});

	it('falls back to A minor pentatonic in tune when the index has no key', () => {
		expect(soloKeyFor(null, 0, 1_000)).toEqual({
			key: 9,
			tonic: 'A',
			scale: 'minorPentatonic',
			tuningCents: 0,
			source: 'default',
		});
	});

	it('maps the chosen key onto the guitar lanes: A blues from A3, D minor pentatonic from D4', () => {
		const range = {low: 40, high: 90};
		const solo = soloKeyFor(ALMORA, 160_000, 188_000);
		expect(laneNotes('guitar', {key: solo.key, scale: solo.scale, octave: 0}, range)).toEqual([57, 60, 62, 63, 64]);
		const song = soloKeyFor(ALMORA, 0, 1_000);
		expect(laneNotes('guitar', {key: song.key, scale: song.scale, octave: 0}, range)).toEqual([62, 65, 67, 69, 72]);
	});
});
