// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildMidi} from '@app/features/activities/band/engine/BandTestFixtures';
import {TempoMap} from '@app/features/activities/band/engine/TempoMap';
import {parseLyric, parseVocalsFromMidi, phraseLyrics} from '@app/features/activities/band/engine/VocalsParser';
import {describe, expect, it} from 'vitest';

const TEMPO_MAP = new TempoMap(480, [{tick: 0, beatsPerMinute: 120}], []);
const latin1 = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));

describe('parseLyric', () => {
	it.each([
		['Hel-', {text: 'Hel', joinsNext: true, isSlide: false, isSpoken: false}],
		['lo', {text: 'lo', joinsNext: false, isSlide: false, isSpoken: false}],
		['Ha#', {text: 'Ha', joinsNext: false, isSlide: false, isSpoken: true}],
		['hey^', {text: 'hey', joinsNext: false, isSlide: false, isSpoken: true}],
		['talk#-', {text: 'talk', joinsNext: true, isSlide: false, isSpoken: true}],
		['+', {text: '', joinsNext: false, isSlide: true, isSpoken: false}],
		['self=', {text: 'self-', joinsNext: true, isSlide: false, isSpoken: false}],
		['$hidden', {text: 'hidden', joinsNext: false, isSlide: false, isSpoken: false}],
		['line/', {text: 'line', joinsNext: false, isSlide: false, isSpoken: false}],
		['up%', {text: 'up', joinsNext: false, isSlide: false, isSpoken: false}],
		['a_b', {text: 'a b', joinsNext: false, isSlide: false, isSpoken: false}],
	])('parses %s', (raw, expected) => {
		expect(parseLyric(raw)).toEqual(expected);
	});
});

describe('parseVocalsFromMidi', () => {
	const midi = buildMidi({
		tracks: [
			{name: 'PART GUITAR', notes: [{tick: 0, note: 96}]},
			{
				name: 'PART VOCALS',
				notes: [
					{tick: 0, note: 105, length: 1900},
					{tick: 0, note: 106, length: 1000},
					{tick: 0, note: 60, length: 200},
					{tick: 240, note: 62, length: 200},
					{tick: 480, note: 64, length: 100},
					{tick: 600, note: 67, length: 100},
					{tick: 960, note: 50, length: 240},
					{tick: 2400, note: 105, length: 480},
					{tick: 2400, note: 70, length: 480},
					{tick: 3000, note: 30, length: 100},
					{tick: 3000, note: 96, length: 100},
					{tick: 0, note: 116, length: 960},
				],
				texts: [
					{tick: 0, text: 'Hel-', kind: 'lyrics'},
					{tick: 240, text: 'lo', kind: 'lyrics'},
					{tick: 480, text: latin1('dün-'), kind: 'lyrics'},
					{tick: 600, text: 'ya', kind: 'lyrics'},
					{tick: 960, text: 'hey#'},
					{tick: 960, text: '[idle]'},
					{tick: 2400, text: '+', kind: 'lyrics'},
				],
			},
		],
	});
	const vocals = parseVocalsFromMidi(midi, TEMPO_MAP)!;

	it('reads pitched notes 36..84 with ms times and drops percussion and out-of-range notes', () => {
		expect(vocals.notes.map((note) => [note.msTime, Math.round(note.msLength), note.pitch])).toEqual([
			[0, 208, 60],
			[250, 208, 62],
			[500, 104, 64],
			[625, 104, 67],
			[1000, 250, null],
			[2500, 500, 70],
		]);
	});

	it('attaches lyrics, decodes UTF-8 and ignores bracketed text events', () => {
		expect(vocals.notes.map((note) => note.lyric)).toEqual(['Hel', 'lo', 'dün', 'ya', 'hey', '']);
		expect(vocals.notes[4].isSpoken).toBe(true);
		expect(vocals.notes[5].isSlide).toBe(true);
	});

	it('merges overlapping phrase markers and indexes notes by phrase', () => {
		expect(vocals.phrases.map((phrase) => [phrase.tick, phrase.length])).toEqual([
			[0, 1900],
			[2400, 480],
		]);
		expect(vocals.notes.map((note) => note.phraseIndex)).toEqual([0, 0, 0, 0, 0, 1]);
		expect(vocals.starPower).toEqual([{tick: 0, length: 960, msTime: 0, msLength: 1000}]);
		expect(vocals.durationMs).toBe(3000);
	});

	it('joins syllables of a phrase into display text', () => {
		expect(phraseLyrics(vocals.notes.filter((note) => note.phraseIndex === 0))).toBe('Hello dünya hey');
	});

	it('returns null without a vocals track', () => {
		const midiWithoutVocals = buildMidi({tracks: [{name: 'PART GUITAR', notes: [{tick: 0, note: 96}]}]});
		expect(parseVocalsFromMidi(midiWithoutVocals, TEMPO_MAP)).toBeNull();
	});
});
