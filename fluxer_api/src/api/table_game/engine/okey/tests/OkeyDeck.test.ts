// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	isOkey,
	newDeck,
	OKEY_TILE_COUNT,
	okeyFaceOf,
	pickIndicator,
	tileFace,
} from '@app/api/table_game/engine/okey/OkeyDeck';
import type {Rng} from '@app/api/table_game/engine/TableGameEngine';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {describe, expect, it} from 'vitest';

// colors: 0 yellow, 1 blue, 2 black, 3 red
const tile = (color: number, number: number, copy = 0) => copy * 52 + color * 13 + number - 1;

function scriptedRng(values: Array<number>): Rng {
	let next = 0;
	return {int: () => values[next++]!};
}

describe('OkeyDeck', () => {
	it('shuffle is Fisher–Yates over rng.int', () => {
		const inner = new SeededRng(42);
		const draws: Array<[number, number]> = [];
		const deck = newDeck({
			int: (n) => {
				const value = inner.int(n);
				draws.push([n, value]);
				return value;
			},
		});

		expect(draws.map(([n]) => n)).toEqual(Array.from({length: OKEY_TILE_COUNT - 1}, (_, k) => OKEY_TILE_COUNT - k));
		const expected = Array.from({length: OKEY_TILE_COUNT}, (_, id) => id);
		draws.forEach(([n, j]) => {
			const i = n - 1;
			[expected[i], expected[j]] = [expected[j]!, expected[i]!];
		});
		expect(deck).toEqual(expected);
		expect(new Set(deck).size).toBe(OKEY_TILE_COUNT);
	});

	it('same seed same deck', () => {
		expect(newDeck(new SeededRng(7))).toEqual(newDeck(new SeededRng(7)));
		expect(newDeck(new SeededRng(7))).not.toEqual(newDeck(new SeededRng(8)));
	});

	it('indicator is never a fake okey', () => {
		const deck = [104, 105, tile(2, 9), tile(1, 1)];
		const picked = pickIndicator(deck, scriptedRng([0, 1, 2]));
		expect(picked.indicator).toBe(tile(2, 9));
		expect(picked.rest).toEqual([104, 105, tile(1, 1)]);

		for (let seed = 1; seed <= 500; seed++) {
			const rng = new SeededRng(seed);
			const {indicator, rest} = pickIndicator(newDeck(rng), rng);
			expect(indicator).toBeLessThan(104);
			expect(rest).toHaveLength(OKEY_TILE_COUNT - 1);
			expect(rest).not.toContain(indicator);
		}
	});

	it('okey after 13 is 1 of the same color', () => {
		expect(okeyFaceOf(tile(2, 13))).toEqual({color: 2, number: 1});
		expect(okeyFaceOf(tile(1, 5, 1))).toEqual({color: 1, number: 6});
		const okey = okeyFaceOf(tile(2, 13, 1));
		expect(isOkey(tile(2, 1), okey)).toBe(true);
		expect(isOkey(tile(2, 1, 1), okey)).toBe(true);
		expect(isOkey(tile(3, 1), okey)).toBe(false);
	});

	it('fake okey plays the okey face', () => {
		const okey = okeyFaceOf(tile(3, 9));
		expect(okey).toEqual({color: 3, number: 10});
		expect(tileFace(104, okey)).toEqual({color: 3, number: 10});
		expect(tileFace(105, okey)).toEqual({color: 3, number: 10});
		expect(isOkey(104, okey)).toBe(false);
		expect(isOkey(105, okey)).toBe(false);
		expect(isOkey(tile(3, 10), okey)).toBe(true);
		expect(tileFace(tile(0, 4), okey)).toEqual({color: 0, number: 4});
	});
});
