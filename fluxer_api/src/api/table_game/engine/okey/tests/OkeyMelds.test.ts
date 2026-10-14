// SPDX-License-Identifier: AGPL-3.0-or-later

import {okeyFaceOf} from '@app/api/table_game/engine/okey/OkeyDeck';
import {canExtend, validatePairs, validateSet} from '@app/api/table_game/engine/okey/OkeyMelds';
import {describe, expect, it} from 'vitest';

// colors: 0 yellow, 1 blue, 2 black, 3 red
const tile = (color: number, number: number, copy = 0) => copy * 52 + color * 13 + number - 1;
const Y = (n: number, copy = 0) => tile(0, n, copy);
const B = (n: number, copy = 0) => tile(1, n, copy);
const K = (n: number, copy = 0) => tile(2, n, copy);
const R = (n: number, copy = 0) => tile(3, n, copy);

// Indicator yellow 5: the okey is yellow 6 (two wild tiles), the fake okeys play yellow 6.
const OKEY = okeyFaceOf(Y(5));
const J = Y(6);
const J2 = Y(6, 1);
const FAKE = 104;

describe('OkeyMelds', () => {
	it('run 12-13-1 valid, 13-1-2 invalid', () => {
		expect(validateSet([B(12), B(13), B(1)], OKEY)).toEqual({kind: 'run', value: 26});
		expect(validateSet([B(11), B(12), B(13), B(1)], OKEY)).toEqual({kind: 'run', value: 37});
		expect(validateSet([B(13), B(1), B(2)], OKEY)).toBeNull();
		expect(validateSet([B(1), B(2), B(3)], OKEY)).toEqual({kind: 'run', value: 6});
		expect(validateSet([B(1), B(2)], OKEY)).toBeNull();
		expect(validateSet([B(3), B(2), B(1)], OKEY)).toBeNull();
		expect(validateSet([B(1), K(2), B(3)], OKEY)).toBeNull();
	});

	it('group needs distinct colors, 3 or 4', () => {
		expect(validateSet([Y(7), B(7), K(7)], OKEY)).toEqual({kind: 'group', value: 21});
		expect(validateSet([Y(7), B(7), K(7), R(7)], OKEY)).toEqual({kind: 'group', value: 28});
		expect(validateSet([Y(7), Y(7, 1), B(7)], OKEY)).toBeNull();
		expect(validateSet([Y(7), B(7)], OKEY)).toBeNull();
		expect(validateSet([Y(7), B(7), K(8)], OKEY)).toBeNull();
		expect(validateSet([Y(7), B(7), K(7), R(7), J], OKEY)).toBeNull();
	});

	it('okey fills any gap', () => {
		expect(validateSet([B(3), J, B(5)], OKEY)).toEqual({kind: 'run', value: 12});
		expect(validateSet([J, B(4), B(5)], OKEY)).toEqual({kind: 'run', value: 12});
		expect(validateSet([B(4), B(5), J], OKEY)).toEqual({kind: 'run', value: 15});
		expect(validateSet([Y(7), J, K(7)], OKEY)).toEqual({kind: 'group', value: 21});
		expect(validateSet([Y(7), B(7), K(7), J], OKEY)).toEqual({kind: 'group', value: 28});
		expect(validateSet([J, B(1), B(2)], OKEY)).toBeNull();
	});

	it('two okeys in one run', () => {
		expect(validateSet([B(3), J, J2, B(6)], OKEY)).toEqual({kind: 'run', value: 18});
		expect(validateSet([J, J2, B(3), B(4)], OKEY)).toEqual({kind: 'run', value: 10});
		expect(validateSet([B(12), B(13), J, J2], OKEY)).toBeNull();
	});

	it('pairs need identical faces, okey completes a pair', () => {
		expect(
			validatePairs(
				[
					[B(4), B(4, 1)],
					[K(9), K(9, 1)],
				],
				OKEY,
			),
		).toBe(true);
		expect(validatePairs([[B(4), K(4)]], OKEY)).toBe(false);
		expect(validatePairs([[B(4), J]], OKEY)).toBe(true);
		expect(validatePairs([[J, J2]], OKEY)).toBe(true);
		expect(validatePairs([[FAKE, 105]], OKEY)).toBe(true);
		expect(validatePairs([[FAKE, J]], OKEY)).toBe(true);
		expect(validatePairs([[B(4), B(4, 1), J]], OKEY)).toBe(false);
		expect(validatePairs([], OKEY)).toBe(false);
	});

	it('run value counts the tile the okey replaces', () => {
		expect(validateSet([B(10), J, B(12)], OKEY)).toEqual({kind: 'run', value: 33});
		expect(validateSet([J, B(12), B(13)], OKEY)).toEqual({kind: 'run', value: 36});
		expect(validateSet([B(11), B(12), J], OKEY)).toEqual({kind: 'run', value: 36});
		expect(validateSet([B(12), B(13), J], OKEY)).toEqual({kind: 'run', value: 26});
		// a fake okey is not wild: it is a plain yellow 6
		expect(validateSet([FAKE, Y(7), Y(8)], OKEY)).toEqual({kind: 'run', value: 21});
		expect(validateSet([FAKE, B(7), K(7)], OKEY)).toBeNull();
	});

	it('canExtend adds to run ends and to groups up to 4, never to pairs', () => {
		const run = {kind: 'run' as const, tiles: [B(3), B(4), B(5)]};
		expect(canExtend(run, [B(6)], 'end', OKEY)).toBe(true);
		expect(canExtend(run, [B(2)], 'start', OKEY)).toBe(true);
		expect(canExtend(run, [B(6)], 'start', OKEY)).toBe(false);
		expect(canExtend(run, [J], 'end', OKEY)).toBe(true);
		expect(canExtend(run, [B(6), B(7)], 'end', OKEY)).toBe(true);
		expect(canExtend(run, [], 'end', OKEY)).toBe(false);
		expect(canExtend({kind: 'run', tiles: [B(11), B(12), B(13)]}, [B(1)], 'end', OKEY)).toBe(true);
		expect(canExtend({kind: 'run', tiles: [B(12), B(13), B(1)]}, [B(2)], 'end', OKEY)).toBe(false);
		const group = {kind: 'group' as const, tiles: [Y(7), B(7), K(7)]};
		expect(canExtend(group, [R(7)], 'end', OKEY)).toBe(true);
		expect(canExtend(group, [B(7, 1)], 'end', OKEY)).toBe(false);
		expect(canExtend({kind: 'group', tiles: [Y(7), B(7), K(7), R(7)]}, [J], 'end', OKEY)).toBe(false);
		expect(canExtend({kind: 'pair', tiles: [B(4), B(4, 1)]}, [J], 'end', OKEY)).toBe(false);
	});
});
