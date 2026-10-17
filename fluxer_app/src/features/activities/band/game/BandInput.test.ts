// SPDX-License-Identifier: AGPL-3.0-or-later

import {DrumLane, FretLane} from '@app/features/activities/band/engine/ChartModel';
import {
	actionForKey,
	BandKeyboard,
	DEFAULT_BAND_KEY_MAP,
	inputSongTimeMs,
	type LaneInput,
} from '@app/features/activities/band/game/BandInput';
import {describe, expect, it} from 'vitest';

function key(code: string, timeStamp: number, extra: Partial<KeyboardEvent> = {}) {
	return {code, timeStamp, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra};
}

function keyboard(part: 'guitar' | 'drums') {
	const lanes: Array<LaneInput> = [];
	const starPower: Array<number> = [];
	const instance = new BandKeyboard(DEFAULT_BAND_KEY_MAP, part, {
		onLane: (input) => lanes.push(input),
		onStarPower: (timeStamp) => starPower.push(timeStamp),
	});
	return {instance, lanes, starPower};
}

describe('BandInput', () => {
	it('maps A S D F G to the frets and H J K L plus Space to the drums', () => {
		expect(
			['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG'].map((code) => actionForKey(DEFAULT_BAND_KEY_MAP, 'bass', code)),
		).toEqual(
			[FretLane.Green, FretLane.Red, FretLane.Yellow, FretLane.Blue, FretLane.Orange].map((lane) => ({
				kind: 'lane',
				lane,
			})),
		);
		expect(actionForKey(DEFAULT_BAND_KEY_MAP, 'rhythm', 'KeyG')).toEqual({kind: 'lane', lane: FretLane.Orange});
		expect(
			['Space', 'KeyH', 'KeyJ', 'KeyK', 'KeyL'].map((code) => actionForKey(DEFAULT_BAND_KEY_MAP, 'drums', code)),
		).toEqual(
			[DrumLane.Kick, DrumLane.Red, DrumLane.Yellow, DrumLane.Blue, DrumLane.Green].map((lane) => ({
				kind: 'lane',
				lane,
			})),
		);
		expect(actionForKey(DEFAULT_BAND_KEY_MAP, 'guitar', 'KeyH')).toEqual({kind: 'none'});
		expect(actionForKey(DEFAULT_BAND_KEY_MAP, 'drums', 'KeyA')).toEqual({kind: 'none'});
		expect(actionForKey(DEFAULT_BAND_KEY_MAP, 'drums', 'Enter')).toEqual({kind: 'starPower'});
	});

	it('takes a custom map', () => {
		const map = {...DEFAULT_BAND_KEY_MAP, frets: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5']};
		expect(actionForKey(map, 'guitar', 'Digit3')).toEqual({kind: 'lane', lane: FretLane.Yellow});
		expect(actionForKey(map, 'guitar', 'KeyD')).toEqual({kind: 'none'});
	});

	it('presses once per key, ignores auto-repeat and modifier chords, and releases on key up', () => {
		const {instance, lanes} = keyboard('guitar');
		expect(instance.keyDown(key('KeyD', 10))).toBe(true);
		expect(instance.keyDown(key('KeyD', 40, {repeat: true}))).toBe(true);
		expect(instance.keyDown(key('KeyD', 41))).toBe(true);
		expect(instance.keyDown(key('KeyS', 50, {ctrlKey: true}))).toBe(false);
		expect(instance.keyDown(key('KeyQ', 55))).toBe(false);
		expect(instance.keyUp(key('KeyD', 90))).toBe(true);
		expect(instance.keyUp(key('KeyS', 95))).toBe(false);
		expect(lanes).toEqual([
			{kind: 'press', lane: FretLane.Yellow, timeStamp: 10},
			{kind: 'release', lane: FretLane.Yellow, timeStamp: 90},
		]);
	});

	it('releases held lanes when focus leaves and fires star power once per press', () => {
		const {instance, lanes, starPower} = keyboard('drums');
		instance.keyDown(key('KeyH', 1));
		instance.keyDown(key('Space', 2));
		instance.keyDown(key('Enter', 3));
		instance.keyDown(key('Enter', 4, {repeat: true}));
		instance.releaseAll(9);
		expect(starPower).toEqual([3]);
		expect(lanes.filter((input) => input.kind === 'release')).toEqual([
			{kind: 'release', lane: DrumLane.Red, timeStamp: 9},
			{kind: 'release', lane: DrumLane.Kick, timeStamp: 9},
		]);
		expect(instance.keyUp(key('KeyH', 12))).toBe(false);
	});

	it('converts an event timestamp to song time through the audio anchor and the latency offset', () => {
		const anchor = {contextTime: 10, performanceTime: 5_000, timeOrigin: 1_700_000_000_000};
		// Pressed 250 ms after the anchor; the song started at context time 8 s; the player is 30 ms late.
		expect(inputSongTimeMs(5_250, anchor, 8, 30)).toBeCloseTo(2_250 - 30);
		expect(inputSongTimeMs(5_250, anchor, 8, -20)).toBeCloseTo(2_270);
	});
});
