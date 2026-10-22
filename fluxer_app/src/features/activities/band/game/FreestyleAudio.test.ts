// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandSongKey} from '@app/features/activities/band/BandProtocol';
import type {SoloSection} from '@app/features/activities/band/engine/FreestyleSolo';
import {
	FreestyleAudio,
	FreestyleKeys,
	type FreestyleSeat,
	PINCH_CHORD_MS,
	type SoloLayout,
} from '@app/features/activities/band/game/FreestyleAudio';
import type {JamMixer, JamNoteOptions, JamPlayable} from '@app/features/activities/band/jam/JamInstruments';
import {JAM_JITTER_BUFFER_MS, type JamMessage} from '@app/features/activities/band/jam/JamMessages';
import {type JamAction, JamPlayer} from '@app/features/activities/band/jam/JamPlayer';
import type {JamInstrument} from '@app/features/activities/band/jam/JamScales';
import {describe, expect, it, vi} from 'vitest';

const A_MINOR: SoloLayout = {key: 9, scale: 'minorPentatonic', notes: [57, 60, 62, 64, 67], pinch: true};

function recorder() {
	const actions: Array<JamAction> = [];
	const keys = new FreestyleKeys((action) => actions.push(action));
	return {keys, actions};
}

describe('FreestyleKeys', () => {
	it('plays each lane as its scale note and lets it go on release', () => {
		const {keys, actions} = recorder();
		keys.press(0, A_MINOR, 1_000);
		keys.press(3, A_MINOR, 1_300);
		keys.release(0, 1_400);
		keys.release(3, 1_500);
		expect(actions).toEqual([
			{kind: 'noteOn', note: 57},
			{kind: 'noteOn', note: 64},
			{kind: 'noteOff', note: 57},
			{kind: 'noteOff', note: 64},
		]);
	});

	it('pinches the higher note when two neighbouring keys go down together, and not on keys', () => {
		const {keys, actions} = recorder();
		keys.press(1, A_MINOR, 1_000);
		keys.press(2, A_MINOR, 1_000 + PINCH_CHORD_MS);
		keys.release(1, 1_200);
		keys.release(2, 1_300);
		expect(actions).toEqual([
			{kind: 'noteOn', note: 60},
			{kind: 'noteOff', note: 60},
			// D over A minor: the third harmonic is A, in the scale.
			{kind: 'noteOn', note: 62, pinchHarmonic: 3},
			{kind: 'noteOff', note: 62},
		]);

		const piano = recorder();
		piano.keys.press(1, {...A_MINOR, pinch: false}, 1_000);
		piano.keys.press(2, {...A_MINOR, pinch: false}, 1_010);
		expect(piano.actions).toEqual([
			{kind: 'noteOn', note: 60},
			{kind: 'noteOn', note: 62},
		]);
	});

	it('plays a neighbour pressed later as its own note', () => {
		const {keys, actions} = recorder();
		keys.press(1, A_MINOR, 1_000);
		keys.press(2, A_MINOR, 1_000 + PINCH_CHORD_MS + 1);
		expect(actions.at(-1)).toEqual({kind: 'noteOn', note: 62});
	});

	it('bends once per press of the bend key and releases everything at the end of a section', () => {
		const {keys, actions} = recorder();
		keys.press(4, A_MINOR, 1_000);
		keys.bend(true, 2, 1_100);
		keys.bend(true, 2, 1_150);
		keys.releaseAll(1_200);
		expect(actions).toEqual([
			{kind: 'noteOn', note: 67},
			{kind: 'bendOn', semitones: 2},
			{kind: 'noteOff', note: 67},
			{kind: 'bendOff'},
		]);
	});
});

interface PlayedNote {
	readonly instrument: JamInstrument;
	readonly note: number;
	readonly time: number;
	readonly options?: JamNoteOptions;
}

function fakeMixer(played: Array<PlayedNote>, currentTime: () => number): JamMixer {
	return {
		context: {
			get currentTime() {
				return currentTime();
			},
		},
		create: (instrument: JamInstrument): JamPlayable => ({
			instrument,
			noteOn: (note, time, options) => played.push({instrument, note, time, options}),
			noteOff: vi.fn(),
			bendOn: vi.fn(),
			bendOff: vi.fn(),
			allNotesOff: vi.fn(),
			dispose: vi.fn(),
		}),
	} as unknown as JamMixer;
}

const SECTION: SoloSection = {
	startMs: 10_000,
	endMs: 20_000,
	firstIndex: 0,
	endIndex: 8,
	cues: [{startMs: 10_000, endMs: 20_000, style: 'free', region: null, notes: 8}],
};
const SEATS: ReadonlyArray<FreestyleSeat> = [
	{userId: 'me', part: 'guitar', sections: [SECTION]},
	{userId: 'keys-player', part: 'keys', sections: [SECTION]},
];
const SONG_KEY: BandSongKey = {
	tonic: 'E',
	mode: 'minor',
	scale: 'minor-pentatonic',
	tuningCents: -20,
	lowConfidence: false,
	solos: [],
};
const RANGES = {guitar: {low: 40, high: 90}, keys: {low: 21, high: 108}};
// Session clock 1000 ms ahead of local epoch time; the AudioContext started at local epoch 0.
const CLOCK_OFFSET_MS = 1_000;

function client(userId: string, contextTime: () => number) {
	const played: Array<PlayedNote> = [];
	const sent: Array<JamMessage> = [];
	const localNow = () => contextTime() * 1000;
	const player = new JamPlayer(
		fakeMixer(played, contextTime),
		{offsetMs: CLOCK_OFFSET_MS, now: () => localNow() + CLOCK_OFFSET_MS},
		{
			send: (message) => sent.push(message),
			readAnchor: () => ({contextTime: contextTime(), performanceTime: localNow(), timeOrigin: 0}),
		},
	);
	const audio = new FreestyleAudio({player, ranges: RANGES, songKey: SONG_KEY, seats: SEATS, myUserId: userId});
	return {audio, played, sent};
}

describe('FreestyleAudio over the network', () => {
	it('sends my solo notes as jam messages and plays them on the other client behind the jitter buffer', () => {
		let now = 12;
		const performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => now * 1000);
		const timeOrigin = vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(0);
		try {
			const me = client('me', () => now);
			const bandmate = client('keys-player', () => now);

			me.audio.press(0, 12_000, 12_000);
			me.audio.press(4, 9_000, 12_000);
			expect(me.played).toEqual([{instrument: 'guitar', note: 52, time: 12, options: expect.any(Object)}]);
			expect(me.sent).toHaveLength(1);

			now = 12.04;
			const lanes = bandmate.audio.receive('me', JSON.parse(JSON.stringify(me.sent[0])), 12_040, 13_040);
			expect(lanes).toEqual([0]);
			expect(bandmate.played).toHaveLength(1);
			expect(bandmate.played[0].instrument).toBe('guitar');
			expect(bandmate.played[0].note).toBe(52);
			expect(bandmate.played[0].time).toBeCloseTo(12 + JAM_JITTER_BUFFER_MS / 1000, 6);

			// Messages from someone not playing freestyle never sound.
			expect(bandmate.audio.receive('stranger', me.sent[0], 12_040, 13_040)).toEqual([]);
			expect(bandmate.played).toHaveLength(1);
		} finally {
			performanceNow.mockRestore();
			timeOrigin.mockRestore();
		}
	});

	it('lays the lanes on the solo key: E minor pentatonic from E3 on the guitar, no pinch on the keys', () => {
		const me = client('me', () => 0);
		expect(me.audio.layout(SEATS[0], SECTION)).toEqual({
			key: 4,
			scale: 'minorPentatonic',
			notes: [52, 55, 57, 59, 62],
			pinch: true,
		});
		expect(me.audio.layout(SEATS[1], SECTION).pinch).toBe(false);
	});
});
