// SPDX-License-Identifier: AGPL-3.0-or-later

import {START_FEN} from '@app/features/table_game/state/TableGameTestViews';
import {
	BOARD_SQUARES,
	boardMarks,
	boardOuterSize,
	boardPieces,
	boardSquareSize,
	boardTurn,
	movePath,
	pieceYaw,
	squarePosition,
} from '@app/features/voice_scene/scene/table/boardLayout';
import type {TableScene3DInput} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {damaSquareIndex} from '@fluxer/constants/src/TableGameConstants';
import type {ChessView, DamaView, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {Vector3} from 'three';
import {describe, expect, it} from 'vitest';

function chess(over: Partial<ChessView> = {}): ChessView {
	return {
		game: 'chess',
		fen: START_FEN,
		white: 1,
		clocks_ms: {white: 600_000, black: 600_000},
		turn_started_at: null,
		last_move: null,
		legal_moves: null,
		in_check: false,
		...over,
	};
}

function damaBoard(cells: Record<string, string>): string {
	const board = Array<string>(64).fill('.');
	for (const [square, cell] of Object.entries(cells)) board[damaSquareIndex(square)] = cell;
	return board.join('');
}

function dama(over: Partial<DamaView> = {}): DamaView {
	return {
		game: 'dama',
		board: damaBoard({}),
		white: 1,
		turn: 1,
		clocks_ms: {white: 600_000, black: 600_000},
		turn_started_at: null,
		last_move: null,
		last_captured: [],
		legal_moves: null,
		...over,
	};
}

function input(gameView: TableGameView['game_view'], over: Partial<TableScene3DInput> = {}): TableScene3DInput {
	return {
		view: {summary: {game: gameView?.game ?? 'chess'}, game_view: gameView} as unknown as TableGameView,
		perspective: 1,
		rack: [],
		stage: null,
		pendingTavla: [],
		selection: null,
		targets: [],
		interactive: true,
		...over,
	};
}

// Root-local position of a square once the board is turned for this perspective.
function rootPosition(square: string, white: 1 | 3, perspective: 1 | 2 | 3 | 4): Vector3 {
	const {x, z} = squarePosition(square, 0.05);
	return new Vector3(x, 0, z).applyAxisAngle(new Vector3(0, 1, 0), boardTurn(white, perspective));
}

describe('boardLayout', () => {
	it('square size = 0.065 × top_size; board centred; my side towards +Z (white flips for position 3)', () => {
		// up from 0.045 so the board comes near; with its frame it stays ≥ 0.2 m inside the table edge.
		expect(boardSquareSize(1.3)).toBeCloseTo(0.0845, 9);
		expect(boardSquareSize(1.4)).toBeCloseTo(0.091, 9);
		// The wooden frame adds 4/7 of a square on each side (32 px around 56 px squares).
		expect(boardOuterSize(1.3)).toBeCloseTo((64 / 7) * 0.0845, 9);
		for (const top of [1.3, 1.4]) expect((top - boardOuterSize(top)) / 2).toBeGreaterThanOrEqual(0.2);
		const s = 0.06;
		expect(squarePosition('a1', s)).toEqual({x: -3.5 * s, z: 3.5 * s});
		expect(squarePosition('h8', s)).toEqual({x: 3.5 * s, z: -3.5 * s});
		const sum = BOARD_SQUARES.map((square) => squarePosition(square, s)).reduce(
			(acc, p) => ({x: acc.x + p.x, z: acc.z + p.z}),
			{x: 0, z: 0},
		);
		expect(sum.x).toBeCloseTo(0, 9);
		expect(sum.z).toBeCloseTo(0, 9);

		// White's first rank is on my edge when I play white, on the far edge when I play black.
		expect(rootPosition('e1', 1, 1).z).toBeGreaterThan(0);
		expect(rootPosition('e1', 1, 3).z).toBeLessThan(0);
		expect(rootPosition('e1', 3, 3).z).toBeGreaterThan(0);
		expect(rootPosition('e1', 3, 1).z).toBeLessThan(0);
		// From my edge, file a is on white's left and file h on black's.
		expect(rootPosition('a1', 1, 1).x).toBeLessThan(0);
		expect(rootPosition('h8', 1, 3).x).toBeLessThan(0);
		// A watcher on the side edge (position 2, counter-clockwise after 1) has the white seat on the left.
		const side = rootPosition('e1', 1, 2);
		expect(side.x).toBeLessThan(0);
		expect(Math.abs(side.z)).toBeLessThan(0.06);
	});

	it('chess pieces from FEN, knights face the opponent', () => {
		const pieces = boardPieces(chess());
		expect(pieces).toHaveLength(32);
		expect(pieces).toContainEqual({square: 'e1', kind: 'k', white: true});
		expect(pieces).toContainEqual({square: 'd8', kind: 'q', white: false});
		expect(pieces.filter((piece) => piece.kind === 'p' && piece.white).map((piece) => piece.square)).toEqual([
			'a2',
			'b2',
			'c2',
			'd2',
			'e2',
			'f2',
			'g2',
			'h2',
		]);
		expect(
			pieces
				.filter((piece) => piece.kind === 'n')
				.map((piece) => piece.square)
				.sort(),
		).toEqual(['b1', 'b8', 'g1', 'g8']);
		// The part's knight looks along +Z; on the board white looks towards rank 8 (−Z), black towards rank 1 (+Z).
		const nose = (white: boolean) => new Vector3(0, 0, 1).applyAxisAngle(new Vector3(0, 1, 0), pieceYaw(white));
		expect(nose(true).z).toBeCloseTo(-1, 9);
		expect(nose(false).z).toBeCloseTo(1, 9);
	});

	it('dama board string → men/kings on the right squares', () => {
		const pieces = boardPieces(dama({board: damaBoard({c3: 'w', f6: 'B', a8: 'b', h1: 'W'})}));
		expect(pieces).toEqual([
			{square: 'a8', kind: 'dm', white: false},
			{square: 'f6', kind: 'dk', white: false},
			{square: 'c3', kind: 'dm', white: true},
			{square: 'h1', kind: 'dk', white: true},
		]);
		expect(boardPieces({...dama({board: damaBoard({b2: 'w'})}), game: 'dama_normal'})).toEqual([
			{square: 'b2', kind: 'dm', white: true},
		]);
		expect(boardPieces(null)).toEqual([]);
	});

	it('legal targets highlight quads; last move squares tinted', () => {
		const marks = boardMarks(
			input(chess({last_move: 'e2e4'}), {
				selection: {kind: 'square', square: 'g1'},
				targets: [{kind: 'square', square: 'f3'}, {kind: 'square', square: 'h3'}, {kind: 'discard_zone'}],
			}),
		);
		expect(marks).toEqual(
			expect.arrayContaining([
				{square: 'e2', kind: 'last'},
				{square: 'e4', kind: 'last'},
				{square: 'g1', kind: 'selected'},
				{square: 'f3', kind: 'target'},
				{square: 'h3', kind: 'target'},
			]),
		);
		expect(marks).toHaveLength(5);

		const damaMarks = boardMarks(input(dama({last_move: ['c3', 'e5', 'c7'], last_captured: ['d4', 'd6']})));
		expect(damaMarks).toEqual([
			{square: 'c3', kind: 'last'},
			{square: 'e5', kind: 'last'},
			{square: 'c7', kind: 'last'},
		]);

		// in_check: the king of the side to move (FEN active colour) is tinted.
		const checked = boardMarks(
			input(chess({fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', in_check: true})),
		);
		expect(checked).toEqual([{square: 'e1', kind: 'check'}]);
		expect(boardMarks(input(chess({fen: '4k3/8/8/8/8/8/8/R3K3 b - - 0 1', in_check: true})))).toEqual([
			{square: 'e8', kind: 'check'},
		]);
		expect(boardMarks(input(null))).toEqual([]);
	});

	it('drop zones are the 64 squares', () => {
		expect(BOARD_SQUARES).toHaveLength(64);
		expect(new Set(BOARD_SQUARES).size).toBe(64);
		expect(BOARD_SQUARES[0]).toBe('a8');
		expect(BOARD_SQUARES[63]).toBe('h1');
		BOARD_SQUARES.forEach((square, index) => expect(damaSquareIndex(square)).toBe(index));
	});

	it('a new last move gives the travelled squares; the first view or the same move gives none', () => {
		expect(movePath(null, chess({last_move: 'e2e4'}))).toBeNull();
		expect(movePath(chess(), chess({last_move: 'e2e4'}))).toEqual(['e2', 'e4']);
		expect(movePath(chess({last_move: 'e7e5'}), chess({last_move: 'g7g8q'}))).toEqual(['g7', 'g8']);
		expect(movePath(chess({last_move: 'e2e4'}), chess({last_move: 'e2e4'}))).toBeNull();
		expect(movePath(chess({last_move: 'e2e4'}), chess({last_move: null}))).toBeNull();
		expect(movePath(dama(), dama({last_move: ['c3', 'e5', 'c7']}))).toEqual(['c3', 'e5', 'c7']);
		expect(movePath(dama({last_move: ['c3', 'e5', 'c7']}), dama({last_move: ['c3', 'e5', 'c7']}))).toBeNull();
		expect(movePath(chess(), null)).toBeNull();
	});
});
