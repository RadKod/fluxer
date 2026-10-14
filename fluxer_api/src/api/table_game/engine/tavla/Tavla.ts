// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import {searchCache} from '@app/api/table_game/engine/SearchCache';
import {
	type EngineClock,
	type Rng,
	type TableGameEngine,
	TableGameRuleError,
	type TablePosition,
} from '@app/api/table_game/engine/TableGameEngine';
import {
	legalSequences,
	playSequence,
	sequenceKey,
	startingBoard,
	type TavlaBoard,
	type TavlaMove,
	type TavlaSequences,
	type TavlaSide,
} from '@app/api/table_game/engine/tavla/TavlaCore';
import {TAVLA_RULES} from '@app/api/table_game/engine/tavla/TavlaRules';
import {TABLE_GAME_POSITIONS, TAVLA_CHECKERS} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameResult, TableGameRuleReason} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Tavla, one game . Notation for clients: TavlaCore's header. Plain JSON for the KV envelope.
// Dice are rolled from rng.int(6) only when a turn starts; the state holds this turn's roll and nothing ahead.
type TavlaPosition = 1 | 3;

export interface TavlaState extends TavlaBoard {
	readonly white: TavlaPosition;
	readonly turn: TavlaPosition;
	readonly dice: readonly [number, number];
	readonly opening: readonly [number, number] | null; // [white's die, black's die], first turn only
	readonly deadlineAt: number;
	readonly lastMoves: ReadonlyArray<TavlaMove & {readonly hit: boolean}>;
	readonly timeouts: ReadonlyArray<number>; // consecutive timeouts per position - 1 (the service reads this)
	readonly turns: number; // turns started after the first, passes included
	readonly result: TableGameResult | null;
}

// A pass chain needs both players stuck roll after roll; a lasting mutual block cannot be reached, so this cap only keeps one request bounded. Past it the stuck player shows legal_moves [] and passes on the deadline.
const MAX_PASSES = 16;

const other = (position: TavlaPosition): TavlaPosition => (position === 1 ? 3 : 1);
const sideOf = (state: TavlaState, position: TavlaPosition): TavlaSide =>
	position === state.white ? 'white' : 'black';
const roll = (rng: Rng) => rng.int(6) + 1;
// One generation per position serves the move check, the pass check, the mover's view and every later GET or illegal
// move on it. Points and bars fix the position (off counts follow from them); 256 positions per API process.
// A held generation measured ~65 KB at 950 plays and ~184 KB at 2210 (a double reaches 3060; a non-double has ≤ 450),
// so only generations up to TAVLA_CACHE_PLAYS_MAX plays are held: ≤ ~18 MB for the whole cache in one process.
// TEMPORARY: a bigger one is generated again on each use (≤ ~5 ms, a few times a turn). Trigger and path: the
// legal_moves note in `view`; the same warning counts these positions.
const TAVLA_CACHE_PLAYS_MAX = 1000;
const plays = searchCache<TavlaSequences>(256, ({accepted}) => accepted.size <= TAVLA_CACHE_PLAYS_MAX);
// The signal for the legal_moves note in `view`: a generation whose legal_moves JSON passes this warns once.
const TAVLA_LEGAL_MOVES_WARN_BYTES = 16 * 1024;
// Move generations run in this process so far (the warning and the cache's tests read it).
let generations = 0;
export const tavlaGenerations = (): number => generations;
function playsOf(state: TavlaState): TavlaSequences {
	const side = sideOf(state, state.turn);
	return plays(`${side}|${state.dice}|${state.points}|${state.bar.white},${state.bar.black}`, () => {
		generations++;
		const generated = legalSequences(state, side, state.dice);
		const bytes = generated.sequences.reduce((sum, key) => sum + key.length + 3, 1); // as JSON: quotes, commas, []
		if (bytes > TAVLA_LEGAL_MOVES_WARN_BYTES) {
			Logger.warn({sequences: generated.sequences.length, bytes, generations}, 'Tavla legal moves over 16 KB');
		}
		return generated;
	});
}

function fail(reason: TableGameRuleReason): never {
	throw new TableGameRuleError(reason);
}

function beginTurn(state: TavlaState, position: TavlaPosition, rng: Rng, clock: EngineClock): TavlaState {
	return {
		...state,
		turn: position,
		dice: [roll(rng), roll(rng)],
		opening: null,
		deadlineAt: clock.now + clock.turnMs,
		turns: state.turns + 1,
	};
}

// The other player's turn; whoever has no play for the roll passes at once and the next one is rolled.
function passTurn(state: TavlaState, rng: Rng, clock: EngineClock): TavlaState {
	let next = beginTurn(state, other(state.turn), rng, clock);
	for (let passes = 0; passes < MAX_PASSES && playsOf(next).sequences.length === 0; passes++) {
		next = beginTurn(next, other(next.turn), rng, clock);
	}
	return next;
}

// `key` is an accepted canonical sequence for the player on turn.
function play(state: TavlaState, key: string, rng: Rng, clock: EngineClock): TavlaState {
	const side = sideOf(state, state.turn);
	const played = playSequence(state, side, key);
	const next: TavlaState = {...state, ...played.board, lastMoves: played.moves};
	if (next.off[side] < TAVLA_CHECKERS) return passTurn(next, rng, clock);
	const mars = TAVLA_RULES.MARS && next.off[side === 'white' ? 'black' : 'white'] === 0;
	return {
		...next,
		result: {kind: 'win', winners: [state.turn], reason: 'bear_off', ...(mars ? {finish: 'mars' as const} : {})},
	};
}

const replaceAt = (items: ReadonlyArray<number>, index: number, value: number) =>
	items.map((item, at) => (at === index ? value : item));

export const Tavla: TableGameEngine<TavlaState> = {
	kind: 'tavla',
	positions: TABLE_GAME_POSITIONS.tavla,

	start(_positions, rng, clock) {
		const white: TavlaPosition = rng.int(2) === 0 ? 1 : 3;
		let opening: [number, number];
		do opening = [roll(rng), roll(rng)];
		while (opening[0] === opening[1]);
		return {
			...startingBoard(),
			white,
			turn: opening[0] > opening[1] ? white : other(white),
			// T1: the winner rolls again (a), or plays the opening dice (b). Every roll has a play from the start.
			dice: TAVLA_RULES.OPENING === 'reroll' ? [roll(rng), roll(rng)] : opening,
			opening,
			deadlineAt: clock.now + clock.turnMs,
			lastMoves: [],
			timeouts: [0, 0, 0, 0],
			turns: 0,
			result: null,
		};
	},

	apply(state, actor: TablePosition, action, rng, clock) {
		if (state.result !== null) fail('game_over');
		if (actor !== 1 && actor !== 3) fail('not_your_turn');
		if (action.type === 'resign') {
			return {...state, result: {kind: 'win', winners: [other(actor)], reason: 'resign'}}; // T9: never mars
		}
		if (action.type !== 'tavla_move') fail('unsupported_action');
		if (actor !== state.turn) fail('not_your_turn');
		const key = sequenceKey(sideOf(state, actor), action.moves);
		if (!playsOf(state).accepted.has(key)) fail('illegal_move');
		return play({...state, timeouts: replaceAt(state.timeouts, actor - 1, 0)}, key, rng, clock);
	},

	onDeadline(state, rng, clock) {
		if (state.result !== null) return state;
		const actor = state.turn;
		const [first] = playsOf(state).sequences;
		if (first === undefined) return passTurn(state, rng, clock);
		const count = state.timeouts[actor - 1]! + 1;
		const counted = {...state, timeouts: replaceAt(state.timeouts, actor - 1, count)};
		if (count >= TAVLA_RULES.MAX_CONSECUTIVE_TIMEOUTS) {
			return {...counted, result: {kind: 'forfeit', loser: actor, reason: 'timeouts'}};
		}
		return play(counted, first, rng, clock); // T7: farthest first
	},

	forfeit(state, loser, reason) {
		return state.result !== null ? state : {...state, result: {kind: 'forfeit', loser, reason}};
	},

	cancel(state, reason) {
		return state.result !== null ? state : {...state, result: {kind: 'canceled', reason}};
	},

	deadline(state) {
		return state.result !== null ? null : state.deadlineAt;
	},

	result(state) {
		return state.result;
	},

	view(state, viewer) {
		const ended = state.result !== null;
		return {
			game: 'tavla',
			white: state.white,
			points: [...state.points],
			bar: {...state.bar},
			off: {...state.off},
			turn: ended ? null : state.turn,
			dice: ended ? null : [...state.dice],
			opening: ended || state.opening === null ? null : [...state.opening],
			deadline_at: ended ? null : new Date(state.deadlineAt).toISOString(),
			last_moves: state.lastMoves.map((move) => ({...move})),
			// TEMPORARY: the mover's view carries every distinct play (a double can list thousands).
			// Trigger: a mover's legal_moves p99 > 16 KB, i.e. the 'Tavla legal moves over 16 KB' warning (playsOf) on more
			// than 1 in 100 generations; its `generations` field is the process's running count. Path: move the generator
			// to packages/constants/src/TavlaMoves.ts so the client lists the plays itself and the server only checks them.
			legal_moves: !ended && viewer === state.turn ? [...playsOf(state).sequences] : null,
		};
	},
};
