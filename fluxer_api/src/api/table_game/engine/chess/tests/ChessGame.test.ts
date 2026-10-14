// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChessGame, type ChessState} from '@app/api/table_game/engine/chess/ChessGame';
import {type Rng, TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import {ChessView, type TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {Chess} from 'chess.js';
import {describe, expect, it} from 'vitest';

const NOW = 1_000_000;
const TEN_MIN = TABLE_GAME_TURN_MS.chess.normal;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const noRng: Rng = {
	int: () => {
		throw new Error('chess must not draw randomness after start');
	},
};

const clockAt = (now: number) => ({now, turnMs: TEN_MIN});

function startGame(pick = 0, now = NOW): ChessState {
	return ChessGame.start([1, 3], {int: () => pick}, clockAt(now));
}

const whiteIsOne = () => {
	const state = startGame(0);
	return state.white === 1 ? state : startGame(1);
};

function fromFen(fen: string): ChessState {
	return {...whiteIsOne(), fen, repetition: []};
}

function chessView(state: ChessState, viewer: TablePosition | null): ChessView {
	const view = ChessGame.view(state, viewer);
	if (view?.game !== 'chess') throw new Error('expected a chess view');
	return view;
}

function moverOf(state: ChessState): 1 | 3 {
	const view = chessView(state, null);
	return (view.fen.split(' ')[1] === 'w') === (view.white === 1) ? 1 : 3;
}

function moveAction(uci: string): TableGameAction {
	const [from, to, promotion] = [uci.slice(0, 2), uci.slice(2, 4), uci[4] as 'q' | 'r' | 'b' | 'n' | undefined];
	return promotion ? {type: 'move', from, to, promotion} : {type: 'move', from, to};
}

function play(state: ChessState, ucis: ReadonlyArray<string>, now = NOW): ChessState {
	return ucis.reduce(
		(current, uci) => ChessGame.apply(current, moverOf(current), moveAction(uci), noRng, clockAt(now)),
		state,
	);
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

describe('ChessGame', () => {
	it('start assigns white randomly between positions 1 and 3 via rng', () => {
		const calls: Array<number> = [];
		const whites = [0, 1].map(
			(pick) =>
				ChessGame.start(
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
		expect(calls).toEqual([2, 2]);
		expect(new Set(whites)).toEqual(new Set([1, 3]));
		const view = chessView(startGame(), null);
		expect(view.fen).toBe(START_FEN);
		expect(view.clocks_ms).toEqual({white: TEN_MIN, black: TEN_MIN});
		expect(view.turn_started_at).toBe(new Date(NOW).toISOString());
		expect(view.last_move).toBeNull();
		expect(ChessGame.kind).toBe('chess');
		expect(ChessGame.positions).toEqual([1, 3]);
	});

	it('legal move applies and switches turn', () => {
		const state = whiteIsOne();
		const before = JSON.stringify(state);
		const next = ChessGame.apply(state, 1, moveAction('e2e4'), noRng, clockAt(NOW));
		expect(JSON.stringify(state)).toBe(before);
		const view = chessView(next, 3);
		expect(view.fen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
		expect(view.last_move).toBe('e2e4');
		expect(view.legal_moves).toHaveLength(20);
		expect(chessView(next, 1).legal_moves).toBeNull();
		expect(ChessGame.result(next)).toBeNull();
	});

	it('illegal move → illegal_move, state unchanged', () => {
		const state = whiteIsOne();
		const before = JSON.stringify(state);
		expect(rejection(() => ChessGame.apply(state, 1, moveAction('e2e5'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(rejection(() => ChessGame.apply(state, 1, moveAction('e7e5'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(rejection(() => ChessGame.apply(state, 1, moveAction('e2e4q'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(rejection(() => ChessGame.apply(state, 3, moveAction('e7e5'), noRng, clockAt(NOW)))).toBe('not_your_turn');
		expect(rejection(() => ChessGame.apply(state, 2, moveAction('e2e4'), noRng, clockAt(NOW)))).toBe('not_your_turn');
		expect(JSON.stringify(state)).toBe(before);
	});

	it('promotion requires piece', () => {
		const state = fromFen('k7/4P3/8/8/8/8/8/4K3 w - - 0 1');
		expect(rejection(() => ChessGame.apply(state, 1, moveAction('e7e8'), noRng, clockAt(NOW)))).toBe('illegal_move');
		expect(chessView(state, 1).legal_moves).toEqual(expect.arrayContaining(['e7e8q', 'e7e8r', 'e7e8b', 'e7e8n']));
		const next = ChessGame.apply(state, 1, moveAction('e7e8n'), noRng, clockAt(NOW));
		expect(chessView(next, null).fen.split(' ')[0]).toBe('k3N3/8/8/8/8/8/8/4K3');
		expect(chessView(next, null).last_move).toBe('e7e8n');
	});

	it("mover's clock is charged elapsed time", () => {
		const afterWhite = ChessGame.apply(whiteIsOne(), 1, moveAction('e2e4'), noRng, clockAt(NOW + 5_000));
		expect(chessView(afterWhite, null).clocks_ms).toEqual({white: TEN_MIN - 5_000, black: TEN_MIN});
		expect(chessView(afterWhite, null).turn_started_at).toBe(new Date(NOW + 5_000).toISOString());
		const afterBlack = ChessGame.apply(afterWhite, 3, moveAction('e7e5'), noRng, clockAt(NOW + 7_000));
		expect(chessView(afterBlack, null).clocks_ms).toEqual({white: TEN_MIN - 5_000, black: TEN_MIN - 2_000});
	});

	it("deadline = turn start + mover's remaining clock", () => {
		const state = whiteIsOne();
		expect(ChessGame.deadline(state)).toBe(NOW + TEN_MIN);
		const afterWhite = ChessGame.apply(state, 1, moveAction('e2e4'), noRng, clockAt(NOW + 5_000));
		expect(ChessGame.deadline(afterWhite)).toBe(NOW + 5_000 + TEN_MIN);
		const afterBlack = ChessGame.apply(afterWhite, 3, moveAction('e7e5'), noRng, clockAt(NOW + 7_000));
		expect(ChessGame.deadline(afterBlack)).toBe(NOW + 7_000 + TEN_MIN - 5_000);
	});

	it('onDeadline: mover loses on time', () => {
		const state = ChessGame.apply(whiteIsOne(), 1, moveAction('e2e4'), noRng, clockAt(NOW + 5_000));
		const due = ChessGame.deadline(state) as number;
		expect(ChessGame.onDeadline(state, noRng, clockAt(due - 1))).toBe(state);
		const timedOut = ChessGame.onDeadline(state, noRng, clockAt(due));
		expect(ChessGame.result(timedOut)).toEqual({kind: 'win', winners: [1], reason: 'timeout'});
		expect(chessView(timedOut, null).clocks_ms).toEqual({white: TEN_MIN - 5_000, black: 0});
		expect(chessView(timedOut, null).turn_started_at).toBeNull();
		expect(ChessGame.deadline(timedOut)).toBeNull();
		const lateMove = ChessGame.apply(state, 3, moveAction('e7e5'), noRng, clockAt(due + 10));
		expect(ChessGame.result(lateMove)).toEqual({kind: 'win', winners: [1], reason: 'timeout'});
		expect(chessView(lateMove, null).fen).toBe(chessView(state, null).fen);
	});

	it('checkmate → win checkmate', () => {
		const mated = play(whiteIsOne(), ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
		expect(ChessGame.result(mated)).toEqual({kind: 'win', winners: [3], reason: 'checkmate'});
		expect(ChessGame.deadline(mated)).toBeNull();
		expect(chessView(mated, 1).legal_moves).toBeNull();
		expect(rejection(() => ChessGame.apply(mated, 1, moveAction('a2a3'), noRng, clockAt(NOW)))).toBe('game_over');
		const mateOnHundredth = play(fromFen('k7/8/1K6/8/8/8/8/7R w - - 99 80'), ['h1h8']);
		expect(ChessGame.result(mateOnHundredth)).toEqual({kind: 'win', winners: [1], reason: 'checkmate'});
	});

	it('stalemate/insufficient/threefold/fifty-move → draw with reason', () => {
		expect(ChessGame.result(play(fromFen('k7/8/8/8/8/8/8/2Q4K w - - 0 1'), ['c1c7']))).toEqual({
			kind: 'draw',
			reason: 'stalemate',
		});
		expect(ChessGame.result(play(fromFen('k7/8/8/8/8/8/1q6/K7 w - - 0 1'), ['a1b2']))).toEqual({
			kind: 'draw',
			reason: 'insufficient',
		});
		const shuffle = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1'];
		const twice = play(whiteIsOne(), shuffle);
		expect(ChessGame.result(twice)).toBeNull();
		expect(ChessGame.result(play(twice, ['f6g8']))).toEqual({kind: 'draw', reason: 'threefold'});
		expect(ChessGame.result(play(fromFen('k7/8/8/8/8/8/8/K6R w - - 98 80'), ['h1h2']))).toBeNull();
		expect(ChessGame.result(play(fromFen('k7/8/8/8/8/8/8/K6R w - - 99 80'), ['h1h2']))).toEqual({
			kind: 'draw',
			reason: 'fifty_move',
		});
	});

	it('resign → win resign for the other side', () => {
		const state = whiteIsOne();
		expect(ChessGame.result(ChessGame.apply(state, 3, {type: 'resign'}, noRng, clockAt(NOW)))).toEqual({
			kind: 'win',
			winners: [1],
			reason: 'resign',
		});
		const resigned = ChessGame.apply(state, 1, {type: 'resign'}, noRng, clockAt(NOW + 4_000));
		expect(ChessGame.result(resigned)).toEqual({kind: 'win', winners: [3], reason: 'resign'});
		expect(chessView(resigned, null).clocks_ms).toEqual({white: TEN_MIN - 4_000, black: TEN_MIN});
		expect(ChessGame.deadline(resigned)).toBeNull();
	});

	it('forfeit leave/disconnect', () => {
		const state = whiteIsOne();
		const left = ChessGame.forfeit(state, 1, 'leave');
		expect(ChessGame.result(left)).toEqual({kind: 'forfeit', loser: 1, reason: 'leave'});
		expect(ChessGame.deadline(left)).toBeNull();
		expect(ChessGame.result(ChessGame.forfeit(state, 3, 'disconnect'))).toEqual({
			kind: 'forfeit',
			loser: 3,
			reason: 'disconnect',
		});
		expect(ChessGame.result(ChessGame.forfeit(left, 3, 'disconnect'))).toEqual(ChessGame.result(left));
		expect(rejection(() => ChessGame.apply(left, 3, moveAction('e7e5'), noRng, clockAt(NOW)))).toBe('game_over');
	});

	it('cancel ends the game and keeps an earlier result', () => {
		const canceled = ChessGame.cancel(whiteIsOne(), 'theme_changed');
		expect(ChessGame.result(canceled)).toEqual({kind: 'canceled', reason: 'theme_changed'});
		expect(ChessGame.deadline(canceled)).toBeNull();
		const resigned = ChessGame.apply(whiteIsOne(), 1, {type: 'resign'}, noRng, clockAt(NOW));
		expect(ChessGame.result(ChessGame.cancel(resigned, 'disabled'))).toEqual(ChessGame.result(resigned));
	});

	it('non-chess actions → unsupported_action', () => {
		const state = whiteIsOne();
		for (const action of [
			{type: 'tick'},
			{type: 'draw', from: 'pile'},
			{type: 'discard', tile: 't1'},
		] satisfies Array<TableGameAction>) {
			expect(rejection(() => ChessGame.apply(state, 1, action, noRng, clockAt(NOW)))).toBe('unsupported_action');
		}
	});

	it('view: same board for all; legal_moves only for the player to move', () => {
		const state = play(whiteIsOne(), ['e2e4']);
		const views = ([1, 2, 3, 4, null] as const).map((viewer) => chessView(state, viewer));
		for (const view of views) {
			expect(ChessView.parse(view)).toEqual(view);
			expect({...view, legal_moves: null}).toEqual({...views[0], legal_moves: null});
		}
		expect(views.map((view) => view.legal_moves !== null)).toEqual([false, false, true, false, false]);
		expect(views[2].legal_moves).toEqual(expect.arrayContaining(['e7e5', 'g8f6', 'b8c6']));
	});

	it('in_check true after a checking move', () => {
		const start = whiteIsOne();
		expect(chessView(start, null).in_check).toBe(false);
		const checked = play(start, ['e2e4', 'f7f6', 'd1h5']);
		for (const viewer of [1, 3, null] as const) expect(chessView(checked, viewer).in_check).toBe(true);
		expect(chessView(play(checked, ['g7g6']), null).in_check).toBe(false);
	});

	it('legal_moves are UCI exactly as chess.js lists them (castling, en passant, promotion, disambiguation)', () => {
		for (const fen of [
			'r3k2r/1P6/8/3pP3/8/8/8/RN2KN1R w KQkq d6 0 1',
			'r3k2r/8/8/8/3pP3/8/6p1/R3K2R b KQkq e3 0 1',
			'4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1',
		]) {
			const expected = new Chess(fen).moves({verbose: true}).map((move) => move.lan);
			const state = fromFen(fen);
			expect([...(chessView(state, moverOf(state)).legal_moves ?? [])].sort()).toEqual([...expected].sort());
		}
	});
});
