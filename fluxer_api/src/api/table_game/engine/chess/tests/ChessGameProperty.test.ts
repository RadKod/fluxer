// SPDX-License-Identifier: AGPL-3.0-or-later

import {ChessGame, type ChessState} from '@app/api/table_game/engine/chess/ChessGame';
import {TableGameRuleError, type TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import type {ChessView, TableGameAction, TableGameResult} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {Chess} from 'chess.js';
import {describe, expect, it} from 'vitest';

// chess.js move generation costs ~0.9 ms per checked half-move, so 2000 games (~634k half-moves) take ~10 min.
// The suite plays seeds 1–20, which reach checkmate, stalemate, insufficient material, the fifty-move rule and
// timeouts, plus 975, the shortest threefold repetition among seeds 1–2000.
const SEEDS = [...Array.from({length: 20}, (_, index) => index + 1), 975];
const MAX_PLIES = 600;
const CLOCK_MS = TABLE_GAME_TURN_MS.chess.slow;
const FILES = 'abcdefgh';

function chessView(state: ChessState, viewer: TablePosition | null): ChessView {
	const view = ChessGame.view(state, viewer);
	if (view?.game !== 'chess') throw new Error('expected a chess view');
	return view;
}

function moveAction(uci: string): TableGameAction {
	const [from, to, promotion] = [uci.slice(0, 2), uci.slice(2, 4), uci[4] as 'q' | 'r' | 'b' | 'n' | undefined];
	return promotion ? {type: 'move', from, to, promotion} : {type: 'move', from, to};
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

// The engine's verdict must be the one chess.js reaches by playing the same moves from the start.
function expectMatchesReference(result: TableGameResult | null, ref: Chess, mover: TablePosition): string | null {
	expect(result !== null).toBe(ref.isGameOver());
	if (result === null) return null;
	if (ref.isCheckmate()) {
		expect(result).toEqual({kind: 'win', winners: [mover], reason: 'checkmate'});
		return 'checkmate';
	}
	if (result.kind !== 'draw') throw new Error(`expected a draw, got ${JSON.stringify(result)}`);
	const holds = {
		stalemate: ref.isStalemate(),
		insufficient: ref.isInsufficientMaterial(),
		threefold: ref.isThreefoldRepetition(),
		fifty_move: ref.isDrawByFiftyMoves(),
		pile_empty: false,
		lone_kings: false,
		move_limit: false,
	};
	expect(holds[result.reason]).toBe(true);
	return result.reason;
}

describe('ChessGame property', () => {
	it('seeded random games end by chess.js rules, keep clocks sane and reject illegal moves', () => {
		const started = performance.now();
		const endings = new Set<string>();
		for (const seed of SEEDS) {
			const rng = new SeededRng(seed);
			let now = 1_000_000;
			let state = ChessGame.start([1, 3], rng, {now, turnMs: CLOCK_MS});
			const ref = new Chess();
			const flagAtPly = rng.int(10) === 0 ? rng.int(200) : -1;
			for (let ply = 0; ChessGame.result(state) === null; ply++) {
				expect(ply).toBeLessThan(MAX_PLIES);
				const side = ref.turn() === 'w' ? 'white' : 'black';
				const mover: TablePosition = (side === 'white') === (state.white === 1) ? 1 : 3;
				const waiting: TablePosition = mover === 1 ? 3 : 1;
				const view = chessView(state, mover);
				const legal = view.legal_moves ?? [];
				expect(view.fen).toBe(ref.fen({forceEnpassantSquare: true}));
				expect(chessView(state, waiting).legal_moves).toBeNull();
				expect(legal.length).toBe(ref.moves().length);
				expect(Math.min(view.clocks_ms.white, view.clocks_ms.black)).toBeGreaterThan(0);
				expect(ChessGame.deadline(state)).toBe(Date.parse(view.turn_started_at ?? '') + view.clocks_ms[side]);

				const clock = {now, turnMs: CLOCK_MS};
				if (ply === flagAtPly) {
					now = ChessGame.deadline(state) ?? now;
					state = ChessGame.onDeadline(state, rng, {now, turnMs: CLOCK_MS});
					expect(ChessGame.result(state)).toEqual({kind: 'win', winners: [waiting], reason: 'timeout'});
					expect(chessView(state, null).clocks_ms[side]).toBe(0);
					endings.add('timeout');
					break;
				}

				const before = JSON.stringify(state);
				const probe = `${FILES[rng.int(8)]}${rng.int(8) + 1}${FILES[rng.int(8)]}${rng.int(8) + 1}`;
				if (!legal.includes(probe)) {
					expect(rejection(() => ChessGame.apply(state, mover, moveAction(probe), rng, clock))).toBe('illegal_move');
				}
				const uci = legal[rng.int(legal.length)];
				expect(rejection(() => ChessGame.apply(state, waiting, moveAction(uci), rng, clock))).toBe('not_your_turn');

				now += rng.int(2_000);
				const next = ChessGame.apply(state, mover, moveAction(uci), rng, {now, turnMs: CLOCK_MS});
				expect(JSON.stringify(state)).toBe(before);
				ref.move({from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4]});
				state = next;
				const ending = expectMatchesReference(ChessGame.result(state), ref, mover);
				if (ending) endings.add(ending);
			}
		}
		expect([...endings].sort()).toEqual([
			'checkmate',
			'fifty_move',
			'insufficient',
			'stalemate',
			'threefold',
			'timeout',
		]);
		expect(performance.now() - started).toBeLessThan(20_000);
	}, 60_000);
});
