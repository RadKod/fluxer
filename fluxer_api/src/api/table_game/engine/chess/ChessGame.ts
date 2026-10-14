// SPDX-License-Identifier: AGPL-3.0-or-later

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
import {Chess} from 'chess.js';

type ChessPosition = 1 | 3;
type Side = 'white' | 'black';

export interface ChessState {
	white: ChessPosition;
	// FEN keeping the en passant square chess.js tracks, so a reload reproduces chess.js's position hash exactly.
	fen: string;
	// chess.js position hashes since the last pawn move or capture; positions before those can never recur.
	repetition: Array<string>;
	// Remaining ms per side as of turnStartedAt; the mover's clock runs from turnStartedAt.
	clocks: Record<Side, number>;
	turnStartedAt: number | null; // null once the game has ended
	lastMove: string | null; // UCI
	result: TableGameResult | null;
}

const otherPosition = (position: ChessPosition): ChessPosition => (position === 1 ? 3 : 1);
const sideToMove = (fen: string): Side => (fen.split(' ')[1] === 'w' ? 'white' : 'black');
const positionOf = (state: ChessState, side: Side): ChessPosition =>
	side === 'white' ? state.white : otherPosition(state.white);

function deadline(state: ChessState): number | null {
	if (state.result !== null || state.turnStartedAt === null) return null;
	return state.turnStartedAt + state.clocks[sideToMove(state.fen)];
}

function chargedClocks(state: ChessState, now: number): Record<Side, number> {
	if (state.turnStartedAt === null) return state.clocks;
	const side = sideToMove(state.fen);
	const spent = Math.max(0, now - state.turnStartedAt);
	return {...state.clocks, [side]: Math.max(0, state.clocks[side] - spent)};
}

function end(state: ChessState, result: TableGameResult, clocks = state.clocks): ChessState {
	return {...state, clocks, turnStartedAt: null, result};
}

function timeOut(state: ChessState): ChessState {
	const side = sideToMove(state.fen);
	const loser = positionOf(state, side);
	return end(state, {kind: 'win', winners: [otherPosition(loser)], reason: 'timeout'}, {...state.clocks, [side]: 0});
}

function outcome(chess: Chess, mover: ChessPosition, repetitions: number): TableGameResult | null {
	if (chess.isCheckmate()) return {kind: 'win', winners: [mover], reason: 'checkmate'};
	if (chess.isStalemate()) return {kind: 'draw', reason: 'stalemate'};
	if (chess.isInsufficientMaterial()) return {kind: 'draw', reason: 'insufficient'};
	if (repetitions >= 3) return {kind: 'draw', reason: 'threefold'};
	if (chess.isDrawByFiftyMoves()) return {kind: 'draw', reason: 'fifty_move'};
	return null;
}

// SAN always ends with the target square (+ promotion, check mark); castling moves the king to the g or c file.
function sanToUci(from: string, san: string): string {
	if (san.startsWith('O-O')) return `${from}${san.startsWith('O-O-O') ? 'c' : 'g'}${from[1]}`;
	const target = /([a-h][1-8])(?:=([QRBN]))?[+#]?$/.exec(san);
	if (!target) throw new Error(`Unexpected SAN from chess.js: ${san}`);
	return `${from}${target[1]}${target[2]?.toLowerCase() ?? ''}`;
}

// Per-square SAN is ~13x cheaper than chess.js verbose moves, which rebuild SAN and two FENs for every move.
function legalMoves(fen: string): Array<string> {
	const chess = new Chess(fen);
	const color = chess.turn();
	const moves: Array<string> = [];
	for (const row of chess.board()) {
		for (const cell of row) {
			if (cell === null || cell.color !== color) continue;
			for (const san of chess.moves({square: cell.square})) moves.push(sanToUci(cell.square, san));
		}
	}
	return moves;
}

function applyMove(
	state: ChessState,
	actor: TablePosition,
	action: Extract<TableGameAction, {type: 'move'}>,
	now: number,
) {
	const side = sideToMove(state.fen);
	const mover = positionOf(state, side);
	if (actor !== mover) throw new TableGameRuleError('not_your_turn');
	const chess = new Chess(state.fen);
	let move: ReturnType<Chess['move']>;
	try {
		move = chess.move({from: action.from, to: action.to, promotion: action.promotion});
	} catch {
		throw new TableGameRuleError('illegal_move');
	}
	if (action.promotion !== undefined && !move.isPromotion()) throw new TableGameRuleError('illegal_move');
	const fen = chess.fen({forceEnpassantSquare: true});
	const hash = chess.hash();
	const repetition = fen.split(' ')[4] === '0' ? [hash] : [...state.repetition, hash];
	const next: ChessState = {
		...state,
		fen,
		repetition,
		clocks: chargedClocks(state, now),
		turnStartedAt: now,
		lastMove: move.lan,
	};
	const result = outcome(chess, mover, repetition.filter((seen) => seen === hash).length);
	return result === null ? next : end(next, result);
}

export const ChessGame: TableGameEngine<ChessState> = {
	kind: 'chess',
	positions: TABLE_GAME_POSITIONS.chess,

	start(_positions: ReadonlyArray<TablePosition>, rng: Rng, clock: EngineClock): ChessState {
		const chess = new Chess();
		return {
			white: rng.int(2) === 0 ? 1 : 3,
			fen: chess.fen({forceEnpassantSquare: true}),
			repetition: [chess.hash()],
			clocks: {white: clock.turnMs, black: clock.turnMs},
			turnStartedAt: clock.now,
			lastMove: null,
			result: null,
		};
	},

	apply(state: ChessState, actor: TablePosition, action: TableGameAction, _rng: Rng, clock: EngineClock): ChessState {
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
		if (action.type !== 'move') throw new TableGameRuleError('unsupported_action');
		return applyMove(state, actor, action, clock.now);
	},

	onDeadline(state: ChessState, _rng: Rng, clock: EngineClock): ChessState {
		const due = deadline(state);
		if (due === null || clock.now < due) return state;
		return timeOut(state);
	},

	forfeit(state: ChessState, loser: TablePosition, reason: 'leave' | 'disconnect'): ChessState {
		if (state.result !== null) return state;
		return end(state, {kind: 'forfeit', loser, reason});
	},

	cancel(state: ChessState, reason: 'disabled' | 'theme_changed' | 'abandoned'): ChessState {
		if (state.result !== null) return state;
		return end(state, {kind: 'canceled', reason});
	},

	deadline,

	result(state: ChessState): TableGameResult | null {
		return state.result;
	},

	view(state: ChessState, viewer: TablePosition | null): TableGameView['game_view'] {
		const toMove = state.result === null ? positionOf(state, sideToMove(state.fen)) : null;
		return {
			game: 'chess',
			fen: state.fen,
			white: state.white,
			clocks_ms: {...state.clocks},
			turn_started_at: state.turnStartedAt === null ? null : new Date(state.turnStartedAt).toISOString(),
			last_move: state.lastMove,
			legal_moves: viewer !== null && viewer === toMove ? legalMoves(state.fen) : null,
			in_check: new Chess(state.fen).isCheck(),
		};
	},
};
