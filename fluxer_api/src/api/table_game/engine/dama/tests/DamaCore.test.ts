// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	applyPath,
	type DamaRuleSet,
	type DamaSide,
	damaSearchedNodes,
	initialBoard,
	legalPaths,
} from '@app/api/table_game/engine/dama/DamaCore';
import {DAMA_NORMAL_RULES, DAMA_RULES} from '@app/api/table_game/engine/dama/DamaRules';
import {damaSquareIndex} from '@fluxer/constants/src/TableGameConstants';
import {describe, expect, it} from 'vitest';

type Piece = 'w' | 'b' | 'W' | 'B';

const FILES = 'abcdefgh';

function boardOf(pieces: Record<string, Piece>): string {
	const cells = Array<string>(64).fill('.');
	for (const [square, piece] of Object.entries(pieces)) cells[damaSquareIndex(square)] = piece;
	return cells.join('');
}

const pieceAt = (board: string, square: string) => board[damaSquareIndex(square)];

function paths(board: string, side: DamaSide, rules: DamaRuleSet): Array<string> {
	return legalPaths(board, side, rules)
		.map((path) => path.join('-'))
		.sort();
}

function onlyMove(board: string, side: DamaSide, rules: DamaRuleSet) {
	const all = legalPaths(board, side, rules);
	expect(all).toHaveLength(1);
	const move = applyPath(board, side, rules, all[0]!);
	if (move === null) throw new Error('the only listed move must apply');
	return {path: all[0]!, ...move};
}

const played = (board: string, side: DamaSide, rules: DamaRuleSet, path: string) =>
	applyPath(board, side, rules, path.split('-'));

describe('DamaCore — Türk daması', () => {
	it('starts with 16 men per side on ranks 2–3 and 6–7', () => {
		const board = initialBoard(DAMA_RULES);
		for (let rank = 1; rank <= 8; rank++) {
			const row = FILES.split('').map((file) => pieceAt(board, `${file}${rank}`));
			const expected = rank === 2 || rank === 3 ? 'w' : rank === 6 || rank === 7 ? 'b' : '.';
			expect(row.join('')).toBe(expected.repeat(8));
		}
		expect(paths(board, 'white', DAMA_RULES)).toHaveLength(8);
	});

	it('men move forward or sideways, never back or diagonal', () => {
		expect(paths(boardOf({d4: 'w'}), 'white', DAMA_RULES)).toEqual(['d4-c4', 'd4-d5', 'd4-e4']);
		expect(paths(boardOf({d5: 'b'}), 'black', DAMA_RULES)).toEqual(['d5-c5', 'd5-d4', 'd5-e5']);
	});

	it('men capture forward/sideways only', () => {
		const board = boardOf({d4: 'w', d5: 'b', c4: 'b', d3: 'b', e5: 'b'});
		expect(paths(board, 'white', DAMA_RULES)).toEqual(['d4-b4', 'd4-d6']);
	});

	it('captured piece is removed at once and its square can be crossed again', () => {
		const board = boardOf({d1: 'W', d3: 'b', f6: 'b', g4: 'b', e3: 'b'});
		expect(paths(board, 'white', DAMA_RULES)).toEqual([
			'd1-d6-g6-g3-a3',
			'd1-d6-g6-g3-b3',
			'd1-d6-g6-g3-c3',
			'd1-d6-g6-g3-d3',
		]);
		const crossing = played(board, 'white', DAMA_RULES, 'd1-d6-g6-g3-a3');
		expect(crossing?.captured).toEqual(['d3', 'f6', 'g4', 'e3']);
		expect(crossing?.board).toBe(boardOf({a3: 'W'}));
	});

	it('king flies orthogonally and captures at distance landing on any empty square beyond', () => {
		expect(paths(boardOf({d4: 'W'}), 'white', DAMA_RULES)).toHaveLength(14);
		expect(paths(boardOf({d4: 'W'}), 'white', DAMA_RULES).some((path) => path === 'd4-e5')).toBe(false);
		expect(paths(boardOf({a1: 'W', a5: 'b'}), 'white', DAMA_RULES)).toEqual(['a1-a6', 'a1-a7', 'a1-a8']);
		// Two pieces in a row cannot be jumped: no capture, so plain moves only.
		expect(paths(boardOf({a1: 'W', a3: 'b', a4: 'b'}), 'white', DAMA_RULES)).toEqual([
			'a1-a2',
			'a1-b1',
			'a1-c1',
			'a1-d1',
			'a1-e1',
			'a1-f1',
			'a1-g1',
			'a1-h1',
		]);
	});

	it('routes taking the same pieces from the same start to the same end are one move, listed once', () => {
		// a1-a4-a7 and a1-a5-a7 both take a3 and a6 and end on a7: one move, the first route found stands for it.
		const board = boardOf({a1: 'W', a3: 'b', a6: 'b'});
		expect(paths(board, 'white', DAMA_RULES)).toEqual(['a1-a4-a7', 'a1-a4-a8']);
		const brazilian = boardOf({a1: 'W', c3: 'b', f6: 'b'});
		expect(paths(brazilian, 'white', DAMA_NORMAL_RULES)).toEqual(['a1-d4-g7', 'a1-d4-h8']);
	});

	it('a request is checked leg by leg: any route taking the most pieces is accepted, nothing else', () => {
		const board = boardOf({a1: 'W', a3: 'b', a6: 'b'});
		expect(played(board, 'white', DAMA_RULES, 'a1-a5-a7')?.board).toBe(boardOf({a7: 'W'}));
		expect(played(board, 'white', DAMA_RULES, 'a1-a4-a7')?.captured).toEqual(['a3', 'a6']);
		expect(played(board, 'white', DAMA_RULES, 'a1-a4')).toBeNull(); // fewer than the most
		expect(played(board, 'white', DAMA_RULES, 'a1-a2')).toBeNull(); // plain move while a capture exists
		expect(played(board, 'white', DAMA_RULES, 'a1-a4-a7-a8')).toBeNull(); // a leg that takes nothing
		expect(played(board, 'white', DAMA_RULES, 'a3-a2')).toBeNull(); // not the mover's piece
		expect(played(board, 'white', DAMA_RULES, 'b2-b3')).toBeNull(); // empty square
		const turn = boardOf({c4: 'W', e4: 'b', b4: 'b'});
		expect(played(turn, 'white', DAMA_RULES, 'c4-f4')).not.toBeNull();
		expect(played(turn, 'white', DAMA_RULES, 'c4-f4-a4')).toBeNull(); // 180° turn
		expect(played(boardOf({d4: 'w'}), 'white', DAMA_RULES, 'd4-d6')).toBeNull(); // a man steps one square
		expect(played(boardOf({d4: 'w'}), 'white', DAMA_RULES, 'd4-d3')).toBeNull(); // never back
	});

	it('king never turns 180° inside a capture', () => {
		const board = boardOf({c4: 'W', e4: 'b', b4: 'b'});
		expect(paths(board, 'white', DAMA_RULES)).toEqual(['c4-a4', 'c4-f4', 'c4-g4', 'c4-h4']);
	});

	it('majority capture is mandatory (men and kings count equal)', () => {
		// Single captures sit both before (a2) and after (e1) the double ones in scan order.
		const board = boardOf({
			h2: 'w',
			h3: 'B',
			h5: 'B',
			c2: 'w',
			c3: 'b',
			c5: 'b',
			a2: 'w',
			a3: 'B',
			e1: 'w',
			e2: 'b',
		});
		expect(paths(board, 'white', DAMA_RULES)).toEqual(['c2-c4-c6', 'h2-h4-h6']);
	});

	it('TD1(a): a man reaching the last row mid-capture continues as a man, promotes only if it ends there', () => {
		const board = boardOf({c6: 'w', c7: 'b', d8: 'b', e5: 'b'});
		const move = onlyMove(board, 'white', DAMA_RULES);
		expect(move.path).toEqual(['c6', 'c8', 'e8']);
		expect(move.captured).toEqual(['c7', 'd8']);
		expect(move.board).toBe(boardOf({e8: 'W', e5: 'b'}));

		expect(paths(board, 'white', {...DAMA_RULES, promoteMidCapture: 'promote_and_continue'})).toEqual([
			'c6-c8-e8-e1',
			'c6-c8-e8-e2',
			'c6-c8-e8-e3',
			'c6-c8-e8-e4',
		]);
		const stop = onlyMove(board, 'white', {...DAMA_RULES, promoteMidCapture: 'stop'});
		expect(stop.path).toEqual(['c6', 'c8']);
		expect(stop.board).toBe(boardOf({c8: 'W', d8: 'b', e5: 'b'}));
	});

	it('a man promotes on a plain move to the last row; a sideways man move is not an advance', () => {
		const promote = played(boardOf({c7: 'w'}), 'white', DAMA_RULES, 'c7-c8');
		expect(promote?.board).toBe(boardOf({c8: 'W'}));
		expect(promote?.advance).toBe(true);
		const sideways = played(boardOf({c4: 'w'}), 'white', DAMA_RULES, 'c4-d4');
		expect(sideways?.advance).toBe(false);
		const king = played(boardOf({c4: 'W'}), 'white', DAMA_RULES, 'c4-c8');
		expect(king?.advance).toBe(false);
	});

	it('a huge capture position is searched but not cached; a small one stays cached', () => {
		// The 547-result lattice of DamaProperty's worst case.
		const huge = 'WWWW.WWW.b..B.......b..BB.B...b..B.b.B..b...B....B.b..b.WWW.B..W';
		const before = damaSearchedNodes();
		expect(legalPaths(huge, 'white', DAMA_RULES)).toHaveLength(547);
		const once = damaSearchedNodes() - before;
		expect(once).toBeGreaterThan(0);
		expect(legalPaths(huge, 'white', DAMA_RULES)).toHaveLength(547);
		expect(damaSearchedNodes() - before).toBe(2 * once);
		const small = boardOf({d4: 'W', d6: 'b'});
		legalPaths(small, 'white', DAMA_RULES);
		const held = damaSearchedNodes();
		legalPaths(small, 'white', DAMA_RULES);
		expect(damaSearchedNodes()).toBe(held);
	});
});

describe('DamaCore — Normal dama (Brezilya)', () => {
	it('starts with 12 men per side on the dark squares of ranks 1–3 and 6–8, a1 dark', () => {
		const board = initialBoard(DAMA_NORMAL_RULES);
		expect(pieceAt(board, 'a1')).toBe('w');
		expect(pieceAt(board, 'b1')).toBe('.');
		expect(pieceAt(board, 'h8')).toBe('b');
		expect([...board].filter((cell) => cell === 'w')).toHaveLength(12);
		expect([...board].filter((cell) => cell === 'b')).toHaveLength(12);
		for (const square of ['a1', 'c1', 'e1', 'g1', 'b2', 'd2', 'f2', 'h2', 'a3', 'c3', 'e3', 'g3']) {
			expect(pieceAt(board, square)).toBe('w');
		}
		for (const square of ['b6', 'd6', 'f6', 'h6', 'a7', 'c7', 'e7', 'g7', 'b8', 'd8', 'f8', 'h8']) {
			expect(pieceAt(board, square)).toBe('b');
		}
		expect(paths(board, 'white', DAMA_NORMAL_RULES)).toEqual([
			'a3-b4',
			'c3-b4',
			'c3-d4',
			'e3-d4',
			'e3-f4',
			'g3-f4',
			'g3-h4',
		]);
	});

	it('men move diagonally forward, capture diagonally both ways', () => {
		expect(paths(boardOf({d4: 'w'}), 'white', DAMA_NORMAL_RULES)).toEqual(['d4-c5', 'd4-e5']);
		expect(paths(boardOf({e5: 'b'}), 'black', DAMA_NORMAL_RULES)).toEqual(['e5-d4', 'e5-f4']);
		expect(paths(boardOf({d4: 'w', c3: 'b', e5: 'b'}), 'white', DAMA_NORMAL_RULES)).toEqual(['d4-b2', 'd4-f6']);
		expect(paths(boardOf({d4: 'w', d5: 'b', c4: 'b'}), 'white', DAMA_NORMAL_RULES)).toEqual(['d4-c5', 'd4-e5']);
	});

	it('flying king on diagonals', () => {
		expect(paths(boardOf({d4: 'W'}), 'white', DAMA_NORMAL_RULES)).toHaveLength(13);
		expect(paths(boardOf({a1: 'W', d4: 'b'}), 'white', DAMA_NORMAL_RULES)).toEqual([
			'a1-e5',
			'a1-f6',
			'a1-g7',
			'a1-h8',
		]);
	});

	it('captured pieces stay as blockers until the move ends; the same piece is never jumped twice', () => {
		// Both ways round the ring take the same four pieces and end on c1: one move. Back on c1 the king may
		// not jump d2 a second time.
		const loop = boardOf({c1: 'W', d2: 'b', e5: 'b', c5: 'b', b2: 'b'});
		expect(paths(loop, 'white', DAMA_NORMAL_RULES)).toEqual(['c1-a3-d6-f4-c1']);

		const blocked = boardOf({c1: 'W', d2: 'b', e5: 'b', c5: 'b', b2: 'b', g5: 'b'});
		expect(paths(blocked, 'white', DAMA_NORMAL_RULES)).toEqual(['c1-a3-d6-f4-c1', 'c1-a3-d6-f4-h6']);
		const ring = played(blocked, 'white', DAMA_NORMAL_RULES, 'c1-a3-d6-f4-c1');
		expect(ring?.captured).toEqual(['b2', 'c5', 'e5', 'd2']);
		expect(ring?.board).toBe(boardOf({c1: 'W', g5: 'b'}));
		// Removing at once (Türk style) would let the king pass the first victim's square again.
		expect(paths(blocked, 'white', {...DAMA_NORMAL_RULES, removeCaptured: 'immediately'})).toEqual([
			'c1-f4-d6-a3-c1-h6',
		]);
	});

	it('majority capture', () => {
		const board = boardOf({a1: 'w', b2: 'b', d4: 'b', h2: 'w', g3: 'b'});
		expect(paths(board, 'white', DAMA_NORMAL_RULES)).toEqual(['a1-c3-e5']);
		const doubleFirst = boardOf({b4: 'w', c5: 'b', e7: 'b', e1: 'w', f2: 'b'});
		expect(paths(doubleFirst, 'white', DAMA_NORMAL_RULES)).toEqual(['b4-d6-f8']);
	});

	it('mid-capture promotion row passes without promoting', () => {
		const passing = onlyMove(boardOf({d6: 'w', e7: 'b', g7: 'b'}), 'white', DAMA_NORMAL_RULES);
		expect(passing.path).toEqual(['d6', 'f8', 'h6']);
		expect(passing.board).toBe(boardOf({h6: 'w'}));

		const ending = onlyMove(boardOf({d6: 'w', e7: 'b'}), 'white', DAMA_NORMAL_RULES);
		expect(ending.path).toEqual(['d6', 'f8']);
		expect(ending.board).toBe(boardOf({f8: 'W'}));
	});
});
