// SPDX-License-Identifier: AGPL-3.0-or-later

import {bandPartKeys, heldLaneCount, keyCapLabel} from '@app/features/activities/band/flow/BandKeyGuide';
import {type BandKeyMap, DEFAULT_BAND_KEY_MAP} from '@app/features/activities/band/game/BandInput';
import {describe, expect, it} from 'vitest';

const summary = (keys: ReturnType<typeof bandPartKeys>) => ({
	lanes: keys.lanes.map((key) => [key.label, key.colour]),
	kick: keys.kick && [keys.kick.label, keys.kick.colour],
	starPower: keys.starPower && [keys.starPower.label, keys.starPower.colour],
});

describe('BandKeyGuide', () => {
	it('shows A S D F G in fret colours and Enter for star power on guitar, bass and keys', () => {
		const expected = {
			lanes: [
				['A', 'green'],
				['S', 'red'],
				['D', 'yellow'],
				['F', 'blue'],
				['G', 'orange'],
			],
			kick: null,
			starPower: ['Enter', null],
		};
		expect(summary(bandPartKeys(DEFAULT_BAND_KEY_MAP, 'guitar'))).toEqual(expected);
		expect(summary(bandPartKeys(DEFAULT_BAND_KEY_MAP, 'bass'))).toEqual(expected);
		expect(summary(bandPartKeys(DEFAULT_BAND_KEY_MAP, 'keys'))).toEqual(expected);
	});

	it('shows H J K L as red, yellow, blue, green pads and Space as the orange kick on drums', () => {
		expect(summary(bandPartKeys(DEFAULT_BAND_KEY_MAP, 'drums'))).toEqual({
			lanes: [
				['H', 'red'],
				['J', 'yellow'],
				['K', 'blue'],
				['L', 'green'],
			],
			kick: ['Space', 'orange'],
			starPower: ['Enter', null],
		});
	});

	it('follows a customised map', () => {
		const map: BandKeyMap = {
			frets: ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'],
			drumPads: ['KeyU', 'KeyI', 'KeyO', 'KeyP'],
			kick: ['KeyB'],
			starPower: ['ShiftLeft'],
		};
		expect(bandPartKeys(map, 'guitar').lanes.map((key) => key.label)).toEqual(['1', '2', '3', '4', '5']);
		expect(bandPartKeys(map, 'guitar').starPower?.label).toBe('Shift');
		expect(bandPartKeys(map, 'drums').kick?.label).toBe('B');
	});

	it('prints key codes the way they look on the keyboard', () => {
		expect(['KeyA', 'Digit7', 'Space', 'Enter', 'ShiftRight'].map(keyCapLabel)).toEqual([
			'A',
			'7',
			'Space',
			'Enter',
			'Shift',
		]);
	});

	it('counts held lanes for the chord check', () => {
		expect(heldLaneCount(DEFAULT_BAND_KEY_MAP, 'guitar', [])).toBe(0);
		expect(heldLaneCount(DEFAULT_BAND_KEY_MAP, 'guitar', ['KeyA'])).toBe(1);
		expect(heldLaneCount(DEFAULT_BAND_KEY_MAP, 'guitar', ['KeyA', 'KeyD', 'KeyG'])).toBe(3);
		expect(heldLaneCount(DEFAULT_BAND_KEY_MAP, 'drums', ['KeyH', 'Space'])).toBe(2);
	});

	it('leaves star power and keys of other parts out of the chord count', () => {
		expect(heldLaneCount(DEFAULT_BAND_KEY_MAP, 'guitar', ['KeyA', 'Enter', 'KeyH', 'KeyQ'])).toBe(1);
		expect(heldLaneCount(DEFAULT_BAND_KEY_MAP, 'drums', ['KeyA', 'KeyS', 'KeyJ'])).toBe(1);
	});
});
