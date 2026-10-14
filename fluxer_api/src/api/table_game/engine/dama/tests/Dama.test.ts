// SPDX-License-Identifier: AGPL-3.0-or-later

import {Dama, type DamaState} from '@app/api/table_game/engine/dama/Dama';
import {initialBoard} from '@app/api/table_game/engine/dama/DamaCore';
import {DamaNormal} from '@app/api/table_game/engine/dama/DamaNormal';
import {DAMA_NORMAL_RULES, DAMA_RULES} from '@app/api/table_game/engine/dama/DamaRules';
import {
	type Rng,
	type TableGameEngine,
	TableGameRuleError,
	type TablePosition,
} from '@app/api/table_game/engine/TableGameEngine';
import {damaSquareIndex, TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import {
	DamaNormalView,
	DamaView,
	type TableGameAction,
	type TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {describe, expect, it} from 'vitest';

type Piece = 'w' | 'b' | 'W' | 'B';
type DamaEngine = TableGameEngine<DamaState>;

const NOW = 1_000_000;
const TEN_MIN = TABLE_GAME_TURN_MS.dama.normal;
const clockAt = (now: number) => ({now, turnMs: TEN_MIN});
const noRng: Rng = {
	int: () => {
		throw new Error('dama must not draw randomness after start');
	},
};

function boardOf(pieces: Record<string, Piece>): string {
	const cells = Array<string>(64).fill('.');
	for (const [square, piece] of Object.entries(pieces)) cells[damaSquareIndex(square)] = piece;
	return cells.join('');
}

// White sits at position 1 (rng pick 0).
function startGame(engine: DamaEngine, now = NOW): DamaState {
	return engine.start([1, 3], {int: () => 0}, clockAt(now));
}

function fromBoard(engine: DamaEngine, pieces: Record<string, Piece>, side: 'white' | 'black' = 'white'): DamaState {
	return {...startGame(engine), board: boardOf(pieces), side, repetition: []};
}

function viewOf(engine: DamaEngine, state: DamaState, viewer: TablePosition | null) {
	const view: TableGameView['game_view'] = engine.view(state, viewer);
	if (view?.game !== engine.kind) throw new Error(`expected a ${engine.kind} view`);
	return view as DamaView | DamaNormalView;
}

const move = (path: string): TableGameAction => ({type: 'dama_move', path: path.split('-')});

function play(engine: DamaEngine, state: DamaState, paths: ReadonlyArray<string>, now = NOW): DamaState {
	return paths.reduce((current, path) => {
		const mover = viewOf(engine, current, null).turn;
		if (mover === null) throw new Error('game over');
		return engine.apply(current, mover, move(path), noRng, clockAt(now));
	}, state);
}

function rejection(fn: () => unknown): string | null {
	try {
		fn();
	} catch (error) {
		if (error instanceof TableGameRuleError) return error.reason;
		throw error;
	}
	return null;
}

describe.each([
	['dama', Dama, DAMA_RULES, 16, 'a3-a4'],
	['dama_normal', DamaNormal, DAMA_NORMAL_RULES, 12, 'a3-b4'],
] as const)('%s engine', (kind, engine, rules, men, opening) => {
	it(`start: ${men} pieces per side on the right rows, white random via rng`, () => {
		const calls: Array<number> = [];
		const whites = [0, 1].map(
			(pick) =>
				engine.start(
					[1, 3],
					{
						int: (n) => {
							calls.push(n);
							return pick;
						},
					},
					clockAt(NOW),
				).white,
		);
		expect(whites).toEqual([1, 3]);
		expect(calls).toEqual([2, 2]);
		const state = startGame(engine);
		expect(state.board).toBe(initialBoard(rules));
		expect([...state.board].filter((cell) => cell === 'w')).toHaveLength(men);
		expect([...state.board].filter((cell) => cell === 'b')).toHaveLength(men);
		const view = viewOf(engine, state, null);
		expect(view).toMatchObject({
			game: kind,
			white: 1,
			turn: 1,
			clocks_ms: {white: TEN_MIN, black: TEN_MIN},
			turn_started_at: new Date(NOW).toISOString(),
			last_move: null,
			last_captured: [],
			legal_moves: null,
		});
		expect(engine.deadline(state)).toBe(NOW + TEN_MIN);
		expect(engine.result(state)).toBeNull();
	});

	it('legal move applies and switches turn; illegal → illegal_move, state unchanged', () => {
		const state = startGame(engine);
		const before = JSON.stringify(state);
		expect(rejection(() => engine.apply(state, 3, move(opening), noRng, clockAt(NOW)))).toBe('not_your_turn');
		expect(rejection(() => engine.apply(state, 1, move('a3-a5'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(rejection(() => engine.apply(state, 1, move('a2-a3'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(rejection(() => engine.apply(state, 1, {type: 'tick'}, noRng, clockAt(NOW)))).toBe('unsupported_action');
		expect(JSON.stringify(state)).toBe(before);

		const next = engine.apply(state, 1, move(opening), noRng, clockAt(NOW + 5_000));
		expect(JSON.stringify(state)).toBe(before);
		const view = viewOf(engine, next, null);
		expect(view.turn).toBe(3);
		expect(view.last_move).toEqual(opening.split('-'));
		expect(view.last_captured).toEqual([]);
		expect(view.board).not.toBe(state.board);
		expect(engine.result(next)).toBeNull();
	});

	it('dama_move must be a full legal path', () => {
		const pieces: Record<string, Record<string, Piece>> = {
			dama: {c2: 'w', c3: 'b', c5: 'b', h7: 'b'},
			dama_normal: {a1: 'w', b2: 'b', d4: 'b', h8: 'b'},
		};
		const full = kind === 'dama' ? 'c2-c4-c6' : 'a1-c3-e5';
		const state = fromBoard(engine, pieces[kind]!);
		const partial = full.split('-').slice(0, 2).join('-');
		expect(rejection(() => engine.apply(state, 1, move(partial), noRng, clockAt(NOW)))).toBe('illegal_move');
		const next = engine.apply(state, 1, move(full), noRng, clockAt(NOW));
		const view = viewOf(engine, next, 3);
		expect(view.last_move).toEqual(full.split('-'));
		expect(view.last_captured).toEqual(kind === 'dama' ? ['c3', 'c5'] : ['b2', 'd4']);
		expect(view.turn).toBe(3);
	});

	it('no pieces left → win no_pieces for the mover', () => {
		const pieces: Record<string, Piece> = kind === 'dama' ? {c2: 'w', c3: 'b'} : {a1: 'w', b2: 'b'};
		const state = fromBoard(engine, pieces);
		const next = play(engine, state, [kind === 'dama' ? 'c2-c4' : 'a1-c3']);
		expect(engine.result(next)).toEqual({kind: 'win', winners: [1], reason: 'no_pieces'});
		expect(engine.deadline(next)).toBeNull();
		const view = viewOf(engine, next, 1);
		expect(view.turn).toBeNull();
		expect(view.legal_moves).toBeNull();
		expect(rejection(() => engine.apply(next, 3, move('h7-h6'), noRng, clockAt(NOW)))).toBe('game_over');
	});

	it('threefold → draw threefold', () => {
		// Two kings a side shuffle; the constructed state has no history, so the first position seen a third
		// time is the one after white's first move, on ply 9.
		const pieces: Record<string, Piece> =
			kind === 'dama' ? {a1: 'W', b1: 'W', h8: 'B', g8: 'B'} : {a1: 'W', c1: 'W', h8: 'B', f8: 'B'};
		const state = fromBoard(engine, pieces);
		const cycle = kind === 'dama' ? ['a1-a2', 'h8-h7', 'a2-a1', 'h7-h8'] : ['c1-d2', 'f8-e7', 'd2-c1', 'e7-f8'];
		const eight = play(engine, state, [...cycle, ...cycle]);
		expect(engine.result(eight)).toBeNull();
		const nine = play(engine, eight, [cycle[0]!]);
		expect(engine.result(nine)).toEqual({kind: 'draw', reason: 'threefold'});
	});

	it('25 quiet full moves → draw move_limit; a capture or a man moving forward resets the count', () => {
		const pieces: Record<string, Piece> = kind === 'dama' ? {a1: 'W', h8: 'B', e2: 'w'} : {a1: 'W', h8: 'B', e3: 'w'};
		const almost = {...fromBoard(engine, pieces), quietMoves: 2 * rules.quietMoveLimit - 1};
		const quiet = play(engine, almost, [kind === 'dama' ? 'a1-a2' : 'a1-b2']);
		expect(engine.result(quiet)).toEqual({kind: 'draw', reason: 'move_limit'});
		const advance = play(engine, almost, [kind === 'dama' ? 'e2-e3' : 'e3-d4']);
		expect(engine.result(advance)).toBeNull();
		expect(advance.quietMoves).toBe(0);
	});

	it('clock: mover charged; deadline; onDeadline loss timeout; a late action loses on time', () => {
		const state = startGame(engine);
		const next = engine.apply(state, 1, move(opening), noRng, clockAt(NOW + 7_000));
		expect(next.clocks).toEqual({white: TEN_MIN - 7_000, black: TEN_MIN});
		expect(engine.deadline(next)).toBe(NOW + 7_000 + TEN_MIN);
		expect(engine.onDeadline(next, noRng, clockAt(NOW + 7_000 + TEN_MIN - 1))).toBe(next);
		const flagged = engine.onDeadline(next, noRng, clockAt(NOW + 7_000 + TEN_MIN));
		expect(engine.result(flagged)).toEqual({kind: 'win', winners: [1], reason: 'timeout'});
		expect(flagged.clocks.black).toBe(0);
		expect(engine.deadline(flagged)).toBeNull();

		const late = engine.apply(state, 1, move(opening), noRng, clockAt(NOW + TEN_MIN));
		expect(engine.result(late)).toEqual({kind: 'win', winners: [3], reason: 'timeout'});
		expect(late.board).toBe(state.board);
	});

	it('resign, forfeit leave/disconnect, cancel', () => {
		const state = startGame(engine);
		const resigned = engine.apply(state, 3, {type: 'resign'}, noRng, clockAt(NOW + 1_000));
		expect(engine.result(resigned)).toEqual({kind: 'win', winners: [1], reason: 'resign'});
		expect(resigned.clocks.white).toBe(TEN_MIN - 1_000);
		expect(engine.result(engine.forfeit(state, 1, 'leave'))).toEqual({kind: 'forfeit', loser: 1, reason: 'leave'});
		expect(engine.result(engine.forfeit(state, 3, 'disconnect'))).toEqual({
			kind: 'forfeit',
			loser: 3,
			reason: 'disconnect',
		});
		expect(engine.result(engine.cancel(state, 'theme_changed'))).toEqual({kind: 'canceled', reason: 'theme_changed'});
		expect(engine.forfeit(resigned, 1, 'leave')).toBe(resigned);
		expect(engine.cancel(resigned, 'disabled')).toBe(resigned);
	});

	it('view: same board for all; legal_moves only for the side to move; parses strictly', () => {
		const schema = kind === 'dama' ? DamaView : DamaNormalView;
		const state = startGame(engine);
		const mover = schema.parse(engine.view(state, 1));
		const waiting = schema.parse(engine.view(state, 3));
		const spectator = schema.parse(engine.view(state, null));
		expect(mover.board).toBe(waiting.board);
		expect(spectator.board).toBe(mover.board);
		expect(mover.legal_moves?.length).toBe(kind === 'dama' ? 8 : 7);
		expect(mover.legal_moves).toContain(opening);
		expect(waiting.legal_moves).toBeNull();
		expect(spectator.legal_moves).toBeNull();
		expect({...mover, legal_moves: null}).toEqual(waiting);
	});
});

describe('Türk daması only', () => {
	it('lone kings → draw lone_kings (TD4)', () => {
		const state = fromBoard(Dama, {d1: 'W', d3: 'b', h8: 'B'});
		const next = play(Dama, state, ['d1-d4']);
		expect(Dama.result(next)).toEqual({kind: 'draw', reason: 'lone_kings'});
	});

	it('a sideways man move is quiet: it neither resets the count nor the repetition history', () => {
		const almost = {...fromBoard(Dama, {a1: 'W', h8: 'B', e2: 'w'}), quietMoves: 49};
		const sideways = play(Dama, almost, ['e2-d2']);
		expect(Dama.result(sideways)).toEqual({kind: 'draw', reason: 'move_limit'});
	});
});

describe('Normal dama only', () => {
	it('no moves left → win blocked for the mover', () => {
		const state = fromBoard(DamaNormal, {a1: 'w', c1: 'w', a3: 'w', c3: 'w', e3: 'w', b2: 'b'});
		const next = play(DamaNormal, state, ['e3-d4']);
		expect(DamaNormal.result(next)).toEqual({kind: 'win', winners: [1], reason: 'blocked'});
	});

	it('lone kings play on (no TD4 in Brazilian rules)', () => {
		const state = fromBoard(DamaNormal, {a1: 'W', c3: 'b', h8: 'B'});
		const next = play(DamaNormal, state, ['a1-d4']);
		expect(next.board).toBe(boardOf({d4: 'W', h8: 'B'}));
		expect(DamaNormal.result(next)).toBeNull();
	});
});
