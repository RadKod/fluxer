// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	DAMA_PATH_MAX,
	damaSquareIndex,
	isKnownTableGameKind,
	okeyTileFace,
	okeyTileToken,
	parseOkeyTileToken,
	TABLE_GAME_CLOCK_KINDS,
	TABLE_GAME_KINDS,
	TABLE_GAME_POSITIONS,
	TABLE_GAME_TURN_MS,
	TAVLA_CHECKERS,
	TAVLA_LEGAL_SEQUENCES_MAX,
	TAVLA_MOVES_MAX,
} from '@fluxer/constants/src/TableGameConstants';
import {describe, expect, test} from 'vitest';

describe('table game constants', () => {
	test('106 distinct tiles: 104 faces in 4 colors × 13 × 2 and 2 fake okeys', () => {
		const faces = new Map<string, number>();
		let fakes = 0;
		for (let id = 0; id < 106; id++) {
			const face = okeyTileFace(id);
			if ('fake' in face) {
				fakes++;
				continue;
			}
			expect(face.color).toBeGreaterThanOrEqual(0);
			expect(face.color).toBeLessThanOrEqual(3);
			expect(face.number).toBeGreaterThanOrEqual(1);
			expect(face.number).toBeLessThanOrEqual(13);
			const key = `${face.color}:${face.number}`;
			faces.set(key, (faces.get(key) ?? 0) + 1);
		}
		expect(fakes).toBe(2);
		expect(okeyTileFace(104)).toEqual({fake: true});
		expect(okeyTileFace(105)).toEqual({fake: true});
		expect(faces.size).toBe(52);
		for (const count of faces.values()) expect(count).toBe(2);
		expect(okeyTileFace(0)).toEqual({color: 0, number: 1});
		expect(okeyTileFace(25)).toEqual({color: 1, number: 13});
		expect(okeyTileFace(52)).toEqual({color: 0, number: 1});
		expect(() => okeyTileFace(106)).toThrow(RangeError);
		expect(() => okeyTileFace(-1)).toThrow(RangeError);
	});

	test('token round trip t0..t105, rejects t106 and t01', () => {
		for (let id = 0; id < 106; id++) {
			expect(parseOkeyTileToken(okeyTileToken(id))).toBe(id);
		}
		for (const token of ['t106', 't01', 't-1', 'T5', 't', '5', 't1.0', ' t1']) {
			expect(parseOkeyTileToken(token)).toBeNull();
		}
	});

	test('turn table normal values are 30 s, 45 s, 10 min', () => {
		expect(TABLE_GAME_TURN_MS.okey.normal).toBe(30_000);
		expect(TABLE_GAME_TURN_MS.okey101.normal).toBe(45_000);
		expect(TABLE_GAME_TURN_MS.chess.normal).toBe(600_000);
	});

	test('six kinds, two-player kinds sit at 1 and 3', () => {
		expect(TABLE_GAME_KINDS).toEqual(['okey', 'okey101', 'chess', 'dama', 'dama_normal', 'tavla']);
		expect(Object.keys(TABLE_GAME_POSITIONS).sort()).toEqual([...TABLE_GAME_KINDS].sort());
		expect(Object.keys(TABLE_GAME_TURN_MS).sort()).toEqual([...TABLE_GAME_KINDS].sort());
		for (const kind of ['okey', 'okey101'] as const) expect(TABLE_GAME_POSITIONS[kind]).toEqual([1, 2, 3, 4]);
		for (const kind of ['chess', 'dama', 'dama_normal', 'tavla'] as const) {
			expect(TABLE_GAME_POSITIONS[kind]).toEqual([1, 3]);
		}
		for (const kind of TABLE_GAME_KINDS) expect(isKnownTableGameKind(kind)).toBe(true);
		expect(isKnownTableGameKind('backgammon')).toBe(false);
	});

	test('dama clocks match chess, tavla turns 20/40/90 s', () => {
		expect(TABLE_GAME_TURN_MS.dama).toEqual(TABLE_GAME_TURN_MS.chess);
		expect(TABLE_GAME_TURN_MS.dama_normal).toEqual(TABLE_GAME_TURN_MS.chess);
		expect(TABLE_GAME_TURN_MS.chess).toEqual({fast: 180_000, normal: 600_000, slow: 1_800_000});
		expect(TABLE_GAME_TURN_MS.tavla).toEqual({fast: 20_000, normal: 40_000, slow: 90_000});
		expect(TABLE_GAME_CLOCK_KINDS).toEqual(['chess', 'dama', 'dama_normal']);
		expect([DAMA_PATH_MAX, TAVLA_MOVES_MAX, TAVLA_CHECKERS, TAVLA_LEGAL_SEQUENCES_MAX]).toEqual([17, 4, 15, 3060]);
	});

	test('damaSquareIndex a8=0 h1=63', () => {
		expect(damaSquareIndex('a8')).toBe(0);
		expect(damaSquareIndex('h8')).toBe(7);
		expect(damaSquareIndex('a7')).toBe(8);
		expect(damaSquareIndex('a1')).toBe(56);
		expect(damaSquareIndex('h1')).toBe(63);
		for (const square of ['i1', 'a9', 'a0', 'A1', 'a', '', 'a10']) {
			expect(() => damaSquareIndex(square)).toThrow(RangeError);
		}
	});
});
