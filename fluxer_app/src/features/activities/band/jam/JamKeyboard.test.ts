// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandJamInstrument} from '@app/features/activities/band/BandProtocol';
import {type BandKeyMap, DEFAULT_BAND_KEY_MAP} from '@app/features/activities/band/game/BandInput';
import {
	JAM_PINCH_WINDOW_MS,
	JamKeyboard,
	type JamKeyboardTarget,
	type JamKeyEvent,
	jamActionForKey,
	pinchLane,
} from '@app/features/activities/band/jam/JamKeyboard';
import type {JamAction} from '@app/features/activities/band/jam/JamPlayer';
import {drumNote} from '@app/features/activities/band/jam/JamScales';
import {describe, expect, it} from 'vitest';

// Lanes on the home row's other side and the bend on Enter, as a player who rebound the game might have them.
const CUSTOM_MAP: BandKeyMap = {
	frets: ['KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
	drumPads: ['KeyA', 'KeyS', 'KeyD', 'KeyF'],
	kick: ['Enter'],
	starPower: ['ShiftRight'],
	whammy: ['Enter'],
};

const LANE_NOTES = [57, 60, 62, 64, 67];

function key(code: string, timeStamp: number, extra: Partial<JamKeyEvent> = {}): JamKeyEvent {
	return {code, timeStamp, repeat: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra};
}

function rig(instrument: BandJamInstrument | null, map: BandKeyMap = DEFAULT_BAND_KEY_MAP) {
	const actions: Array<JamAction> = [];
	const lanes: Array<string> = [];
	const octaves: Array<number> = [];
	let bend = 0;
	const target: JamKeyboardTarget = {
		instrument: () => instrument,
		laneSound: (lane, alternate, pinch) =>
			instrument === 'drums'
				? {note: drumNote(lane, alternate), options: {}}
				: {note: LANE_NOTES[lane], options: pinch ? {pinchHarmonic: 3} : {}},
		play: (action) => actions.push(action),
		shiftOctave: (delta) => octaves.push(delta),
		showLane: (lane, down, pinch) => lanes.push(`${lane}${down ? (pinch ? 'p' : 'd') : 'u'}`),
		showBend: (semitones) => {
			bend = semitones;
		},
	};
	return {keyboard: new JamKeyboard(map, target), actions, lanes, octaves, bend: () => bend};
}

describe('jam key mapping', () => {
	it('plays the lanes from the fret keys of the band key map, including rebound ones', () => {
		expect(jamActionForKey(DEFAULT_BAND_KEY_MAP, 'guitar', 'KeyD', false)).toEqual({
			kind: 'lane',
			lane: 2,
			alternate: false,
		});
		expect(jamActionForKey(CUSTOM_MAP, 'guitar', 'Semicolon', false)).toEqual({
			kind: 'lane',
			lane: 4,
			alternate: false,
		});
		expect(jamActionForKey(CUSTOM_MAP, 'guitar', 'KeyA', false)).toEqual({kind: 'none'});
	});

	it('bends on the kick key, further with Shift, and moves the octave on Z and X', () => {
		expect(jamActionForKey(DEFAULT_BAND_KEY_MAP, 'bass', 'Space', false)).toEqual({kind: 'bend', semitones: 2});
		expect(jamActionForKey(DEFAULT_BAND_KEY_MAP, 'guitar', 'Space', true)).toEqual({kind: 'bend', semitones: 3});
		expect(jamActionForKey(CUSTOM_MAP, 'keys', 'Enter', false)).toEqual({kind: 'bend', semitones: 2});
		expect(jamActionForKey(CUSTOM_MAP, 'keys', 'Space', false)).toEqual({kind: 'none'});
		expect(jamActionForKey(DEFAULT_BAND_KEY_MAP, 'keys', 'KeyZ', false)).toEqual({kind: 'octave', delta: -1});
		expect(jamActionForKey(DEFAULT_BAND_KEY_MAP, 'keys', 'KeyX', false)).toEqual({kind: 'octave', delta: 1});
	});

	it('gives the drums a kick on the kick key and no octave', () => {
		expect(jamActionForKey(DEFAULT_BAND_KEY_MAP, 'drums', 'Space', false)).toEqual({
			kind: 'lane',
			lane: 0,
			alternate: false,
		});
		expect(jamActionForKey(DEFAULT_BAND_KEY_MAP, 'drums', 'KeyZ', false)).toEqual({kind: 'none'});
		expect(jamActionForKey(DEFAULT_BAND_KEY_MAP, 'drums', 'KeyF', true)).toEqual({
			kind: 'lane',
			lane: 3,
			alternate: true,
		});
	});
});

describe('pinch timing', () => {
	it('takes two neighbouring lanes within the window as a pinch of the lower one', () => {
		expect(pinchLane({lane: 2, at: 100}, 1, 100 + JAM_PINCH_WINDOW_MS)).toBe(1);
		expect(pinchLane({lane: 0, at: 100}, 1, 100)).toBe(0);
		expect(pinchLane({lane: 2, at: 100}, 1, 101 + JAM_PINCH_WINDOW_MS)).toBeNull();
		expect(pinchLane({lane: 0, at: 100}, 2, 110)).toBeNull();
		expect(pinchLane({lane: 1, at: 100}, 1, 110)).toBeNull();
		expect(pinchLane(null, 1, 110)).toBeNull();
	});
});

describe('JamKeyboard', () => {
	it('sustains a held note and lets it go on key up', () => {
		const {keyboard, actions, lanes} = rig('keys');
		expect(keyboard.keyDown(key('KeyA', 0))).toBe(true);
		expect(keyboard.keyDown(key('KeyA', 30, {repeat: true}))).toBe(true);
		expect(keyboard.keyUp(key('KeyA', 900))).toBe(true);
		expect(actions).toEqual([
			{kind: 'noteOn', note: 57},
			{kind: 'noteOff', note: 57},
		]);
		expect(lanes).toEqual(['0d', '0u']);
	});

	it('turns two neighbouring lanes struck together on the lead guitar into one pinch of the lower note', () => {
		const {keyboard, actions, lanes} = rig('guitar');
		keyboard.keyDown(key('KeyD', 1_000));
		keyboard.keyDown(key('KeyS', 1_020));
		expect(actions).toEqual([
			{kind: 'noteOn', note: 62},
			{kind: 'noteOff', note: 62},
			{kind: 'noteOn', note: 60, pinchHarmonic: 3},
		]);
		expect(lanes).toEqual(['2d', '2p', '1p']);
		keyboard.keyUp(key('KeyD', 1_500));
		expect(actions).toHaveLength(3);
		keyboard.keyUp(key('KeyS', 1_600));
		expect(actions.at(-1)).toEqual({kind: 'noteOff', note: 60});
	});

	it('plays two notes when the second key comes after the window or on another instrument', () => {
		const late = rig('guitar');
		late.keyboard.keyDown(key('KeyA', 0));
		late.keyboard.keyDown(key('KeyS', JAM_PINCH_WINDOW_MS + 1));
		expect(late.actions).toEqual([
			{kind: 'noteOn', note: 57},
			{kind: 'noteOn', note: 60},
		]);
		const bass = rig('bass');
		bass.keyboard.keyDown(key('KeyA', 0));
		bass.keyboard.keyDown(key('KeyS', 5));
		expect(bass.actions.filter((action) => action.kind === 'noteOn')).toHaveLength(2);
	});

	it('does not pinch from a key already let go', () => {
		const {keyboard, actions} = rig('guitar');
		keyboard.keyDown(key('KeyA', 0));
		keyboard.keyUp(key('KeyA', 10));
		keyboard.keyDown(key('KeyS', 20));
		expect(actions.at(-1)).toEqual({kind: 'noteOn', note: 60});
	});

	it('hits drums with Shift picking the alternate piece and sends no note off', () => {
		const {keyboard, actions} = rig('drums');
		keyboard.keyDown(key('KeyD', 0, {shiftKey: true}));
		keyboard.keyDown(key('Space', 5));
		keyboard.keyUp(key('KeyD', 50));
		keyboard.keyUp(key('Space', 60));
		expect(actions).toEqual([
			{kind: 'noteOn', note: drumNote(2, true)},
			{kind: 'noteOn', note: drumNote(0, false)},
		]);
	});

	it('bends while the bend key is held and shows it', () => {
		const rigged = rig('guitar');
		rigged.keyboard.keyDown(key('KeyA', 0));
		rigged.keyboard.keyDown(key('Space', 100, {shiftKey: true}));
		expect(rigged.bend()).toBe(3);
		rigged.keyboard.keyUp(key('Space', 400));
		expect(rigged.bend()).toBe(0);
		expect(rigged.actions.slice(1)).toEqual([{kind: 'bendOn', semitones: 3}, {kind: 'bendOff'}]);
	});

	it('moves the octave and leaves keys alone without an instrument or with a modifier', () => {
		const {keyboard, octaves} = rig('keys');
		keyboard.keyDown(key('KeyX', 0));
		keyboard.keyDown(key('KeyZ', 10));
		expect(octaves).toEqual([1, -1]);
		expect(keyboard.keyDown(key('KeyA', 20, {ctrlKey: true}))).toBe(false);
		expect(rig(null).keyboard.keyDown(key('KeyA', 0))).toBe(false);
	});

	it('follows rebound lane keys', () => {
		const {keyboard, actions} = rig('keys', CUSTOM_MAP);
		expect(keyboard.keyDown(key('KeyA', 0))).toBe(false);
		keyboard.keyDown(key('KeyL', 0));
		expect(actions).toEqual([{kind: 'noteOn', note: 64}]);
	});

	it('releases everything held when focus leaves', () => {
		const rigged = rig('guitar');
		rigged.keyboard.keyDown(key('KeyA', 0));
		rigged.keyboard.keyDown(key('KeyS', 10));
		rigged.keyboard.keyDown(key('Space', 20));
		rigged.keyboard.releaseAll(30);
		expect(rigged.actions.slice(4)).toEqual([{kind: 'noteOff', note: 57}, {kind: 'bendOff'}]);
		expect(rigged.bend()).toBe(0);
	});
});
