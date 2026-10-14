// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	applyPath,
	type DamaRuleSet,
	type DamaSide,
	hasLegalMove,
	initialBoard,
	legalPaths,
} from '@app/api/table_game/engine/dama/DamaCore';
import {DAMA_RULES} from '@app/api/table_game/engine/dama/DamaRules';
import {
	type EngineClock,
	type Rng,
	type TableGameEngine,
	TableGameRuleError,
	type TablePosition,
} from '@app/api/table_game/engine/TableGameEngine';
import {TABLE_GAME_POSITIONS} from '@fluxer/constants/src/TableGameConstants';
import type {
	TableGameAction,
	TableGameResult,
	TableGameView,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

type DamaPosition = 1 | 3;

export interface DamaState {
	board: string;
	white: DamaPosition;
	side: DamaSide; // to move
	// Remaining ms per side as of turnStartedAt; the mover's clock runs from turnStartedAt.
	clocks: Record<DamaSide, number>;
	turnStartedAt: number | null; // null once the game has ended
	lastMove: Array<string> | null;
	lastCaptured: Array<string>;
	// Positions since the last advance (a capture or a man moving forward); earlier ones can never recur.
	// At most 1 + 2 × quietMoveLimit entries: the move limit ends the game first.
	repetition: Array<string>;
	quietMoves: number; // plies since the last advance
	result: TableGameResult | null;
}

const otherSide = (side: DamaSide): DamaSide => (side === 'white' ? 'black' : 'white');
const otherPosition = (position: DamaPosition): DamaPosition => (position === 1 ? 3 : 1);
const positionOf = (state: DamaState, side: DamaSide): DamaPosition =>
	side === 'white' ? state.white : otherPosition(state.white);
const positionKey = (board: string, side: DamaSide) => `${board}${side === 'white' ? 'w' : 'b'}`;

function deadline(state: DamaState): number | null {
	if (state.result !== null || state.turnStartedAt === null) return null;
	return state.turnStartedAt + state.clocks[state.side];
}

function chargedClocks(state: DamaState, now: number): Record<DamaSide, number> {
	if (state.turnStartedAt === null) return state.clocks;
	const spent = Math.max(0, now - state.turnStartedAt);
	return {...state.clocks, [state.side]: Math.max(0, state.clocks[state.side] - spent)};
}

function end(state: DamaState, result: TableGameResult, clocks = state.clocks): DamaState {
	return {...state, clocks, turnStartedAt: null, result};
}

// TD8 / CD5: the flag decides, whatever is left on the board.
function timeOut(state: DamaState): DamaState {
	const loser = positionOf(state, state.side);
	return end(
		state,
		{kind: 'win', winners: [otherPosition(loser)], reason: 'timeout'},
		{...state.clocks, [state.side]: 0},
	);
}

// Türk daması and Normal dama share the engine; the rule set (DamaRules) is the only difference.
export function createDamaEngine(kind: 'dama' | 'dama_normal', rules: DamaRuleSet): TableGameEngine<DamaState> {
	function outcome(next: DamaState, mover: DamaPosition): TableGameResult | null {
		const pieces = next.board.replace(/\./g, '');
		const theirs = next.side === 'white' ? /[wW]/ : /[bB]/;
		if (!theirs.test(pieces)) return {kind: 'win', winners: [mover], reason: 'no_pieces'};
		if (!hasLegalMove(next.board, next.side, rules)) return {kind: 'win', winners: [mover], reason: 'blocked'};
		if (rules.loneKingsDraw && pieces.length === 2 && pieces.includes('W') && pieces.includes('B')) {
			return {kind: 'draw', reason: 'lone_kings'};
		}
		const key = next.repetition[next.repetition.length - 1];
		if (rules.threefoldDraw && next.repetition.filter((seen) => seen === key).length >= 3) {
			return {kind: 'draw', reason: 'threefold'};
		}
		if (next.quietMoves >= 2 * rules.quietMoveLimit) return {kind: 'draw', reason: 'move_limit'};
		return null;
	}

	function applyMove(
		state: DamaState,
		actor: TablePosition,
		action: Extract<TableGameAction, {type: 'dama_move'}>,
		now: number,
	): DamaState {
		const mover = positionOf(state, state.side);
		if (actor !== mover) throw new TableGameRuleError('not_your_turn');
		const move = applyPath(state.board, state.side, rules, action.path);
		if (move === null) throw new TableGameRuleError('illegal_move');
		const side = otherSide(state.side);
		const key = positionKey(move.board, side);
		const next: DamaState = {
			...state,
			board: move.board,
			side,
			clocks: chargedClocks(state, now),
			turnStartedAt: now,
			lastMove: [...action.path],
			lastCaptured: move.captured,
			repetition: move.advance ? [key] : [...state.repetition, key],
			quietMoves: move.advance ? 0 : state.quietMoves + 1,
		};
		const result = outcome(next, mover);
		return result === null ? next : end(next, result);
	}

	return {
		kind,
		positions: TABLE_GAME_POSITIONS[kind],

		start(_positions: ReadonlyArray<TablePosition>, rng: Rng, clock: EngineClock): DamaState {
			const board = initialBoard(rules);
			const side: DamaSide = rules.whiteStarts ? 'white' : 'black';
			return {
				board,
				white: rng.int(2) === 0 ? 1 : 3,
				side,
				clocks: {white: clock.turnMs, black: clock.turnMs},
				turnStartedAt: clock.now,
				lastMove: null,
				lastCaptured: [],
				repetition: [positionKey(board, side)],
				quietMoves: 0,
				result: null,
			};
		},

		apply(state: DamaState, actor: TablePosition, action: TableGameAction, _rng: Rng, clock: EngineClock): DamaState {
			if (state.result !== null) throw new TableGameRuleError('game_over');
			if (actor !== 1 && actor !== 3) throw new TableGameRuleError('not_your_turn');
			// The flag fell before this action arrived: the first event decides the game.
			const due = deadline(state);
			if (due !== null && clock.now >= due) return timeOut(state);
			if (action.type === 'resign') {
				return end(
					state,
					{kind: 'win', winners: [otherPosition(actor)], reason: 'resign'},
					chargedClocks(state, clock.now),
				);
			}
			if (action.type !== 'dama_move') throw new TableGameRuleError('unsupported_action');
			return applyMove(state, actor, action, clock.now);
		},

		onDeadline(state: DamaState, _rng: Rng, clock: EngineClock): DamaState {
			const due = deadline(state);
			if (due === null || clock.now < due) return state;
			return timeOut(state);
		},

		forfeit(state: DamaState, loser: TablePosition, reason: 'leave' | 'disconnect'): DamaState {
			if (state.result !== null) return state;
			return end(state, {kind: 'forfeit', loser, reason});
		},

		cancel(state: DamaState, reason: 'disabled' | 'theme_changed' | 'abandoned'): DamaState {
			if (state.result !== null) return state;
			return end(state, {kind: 'canceled', reason});
		},

		deadline,

		result(state: DamaState): TableGameResult | null {
			return state.result;
		},

		// Full information: everyone sees the same board; only the player to move gets the legal paths.
		view(state: DamaState, viewer: TablePosition | null): TableGameView['game_view'] {
			const toMove = state.result === null ? positionOf(state, state.side) : null;
			return {
				game: kind,
				board: state.board,
				white: state.white,
				turn: toMove,
				clocks_ms: {...state.clocks},
				turn_started_at: state.turnStartedAt === null ? null : new Date(state.turnStartedAt).toISOString(),
				last_move: state.lastMove === null ? null : [...state.lastMove],
				last_captured: [...state.lastCaptured],
				legal_moves:
					viewer !== null && viewer === toMove
						? legalPaths(state.board, state.side, rules).map((path) => path.join('-'))
						: null,
			};
		},
	};
}

export const Dama = createDamaEngine('dama', DAMA_RULES);
