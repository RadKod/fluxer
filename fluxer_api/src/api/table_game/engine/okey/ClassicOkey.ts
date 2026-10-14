// SPDX-License-Identifier: AGPL-3.0-or-later

import {isOkey, newDeck, type OkeyFace, okeyFaceOf, pickIndicator} from '@app/api/table_game/engine/okey/OkeyDeck';
import {validatePairs, validateSet} from '@app/api/table_game/engine/okey/OkeyMelds';
import {
	type EngineClock,
	type TableGameEngine,
	TableGameRuleError,
	type TablePosition,
} from '@app/api/table_game/engine/TableGameEngine';
import {
	okeyTileToken,
	parseOkeyTileToken,
	TABLE_GAME_MAX_CONSECUTIVE_TIMEOUTS,
} from '@fluxer/constants/src/TableGameConstants';
import type {
	TableGameAction,
	TableGameResult,
	TableGameRuleReason,
} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Classic Okey, one hand. Plain JSON so it can live in the table's KV envelope.
// Arrays indexed by position - 1. this state never leaves the API; clients only get view().
export interface ClassicOkeyState {
	readonly indicator: number;
	readonly pile: ReadonlyArray<number>; // the next draw is the last element
	readonly racks: ReadonlyArray<ReadonlyArray<number>>;
	readonly discards: ReadonlyArray<ReadonlyArray<number>>; // tiles each position threw, oldest first
	readonly turn: TablePosition;
	readonly phase: 'draw' | 'discard';
	readonly lastReceived: number | null; // tile the player on turn got last (timeout discards it)
	readonly deadlineAt: number;
	readonly timeouts: ReadonlyArray<number>; // consecutive timeouts per position
	readonly turns: number; // completed turns
	readonly result: TableGameResult | null;
}

const POSITIONS: ReadonlyArray<TablePosition> = [1, 2, 3, 4];
const OTHERS_DEAL = 14;
const FINISH_TILES = 14;
const FINISH_PAIRS = 7;

const nextPosition = (position: TablePosition) => ((position % 4) + 1) as TablePosition;
const previousPosition = (position: TablePosition) => (((position + 2) % 4) + 1) as TablePosition;

function fail(reason: TableGameRuleReason): never {
	throw new TableGameRuleError(reason);
}

function replaceAt<T>(items: ReadonlyArray<T>, index: number, value: T): Array<T> {
	return items.map((item, at) => (at === index ? value : item));
}

function expectTurn(state: ClassicOkeyState, actor: TablePosition, phase: ClassicOkeyState['phase']): void {
	if (actor !== state.turn) fail('not_your_turn');
	if (state.phase !== phase) fail('wrong_phase');
}

function rackTile(state: ClassicOkeyState, actor: TablePosition, token: string): number {
	const tile = parseOkeyTileToken(token);
	if (tile === null || !state.racks[actor - 1]!.includes(tile)) fail('tile_not_in_rack');
	return tile;
}

function receive(state: ClassicOkeyState, actor: TablePosition, tile: number): ClassicOkeyState {
	return {
		...state,
		racks: replaceAt(state.racks, actor - 1, [...state.racks[actor - 1]!, tile]),
		phase: 'discard',
		lastReceived: tile,
	};
}

function throwTile(state: ClassicOkeyState, actor: TablePosition, tile: number): ClassicOkeyState {
	return {
		...state,
		racks: replaceAt(
			state.racks,
			actor - 1,
			state.racks[actor - 1]!.filter((id) => id !== tile),
		),
		discards: replaceAt(state.discards, actor - 1, [...state.discards[actor - 1]!, tile]),
	};
}

// The next player's draw phase starts; with the pile gone the hand is a draw.
function passTurn(state: ClassicOkeyState, clock: EngineClock): ClassicOkeyState {
	return {
		...state,
		turn: nextPosition(state.turn),
		phase: 'draw',
		lastReceived: null,
		deadlineAt: clock.now + clock.turnMs,
		turns: state.turns + 1,
		result: state.pile.length === 0 ? {kind: 'draw', reason: 'pile_empty'} : null,
	};
}

function resetTimeouts(state: ClassicOkeyState, actor: TablePosition): ClassicOkeyState {
	return {...state, timeouts: replaceAt(state.timeouts, actor - 1, 0)};
}

function draw(state: ClassicOkeyState, actor: TablePosition, from: 'pile' | 'discard'): ClassicOkeyState {
	expectTurn(state, actor, 'draw');
	if (from === 'pile') {
		return receive({...state, pile: state.pile.slice(0, -1)}, actor, state.pile.at(-1)!);
	}
	const offeredBy = previousPosition(actor) - 1;
	const offered = state.discards[offeredBy]!;
	if (offered.length === 0) fail('illegal_move');
	return receive(
		{...state, discards: replaceAt(state.discards, offeredBy, offered.slice(0, -1))},
		actor,
		offered.at(-1)!,
	);
}

function discard(state: ClassicOkeyState, actor: TablePosition, token: string, clock: EngineClock): ClassicOkeyState {
	expectTurn(state, actor, 'discard');
	return passTurn(throwTile(state, actor, rackTile(state, actor, token)), clock);
}

function finish(
	state: ClassicOkeyState,
	actor: TablePosition,
	token: string,
	sets: ReadonlyArray<ReadonlyArray<string>>,
): ClassicOkeyState {
	expectTurn(state, actor, 'discard');
	const tile = rackTile(state, actor, token);
	const melds = sets.map((set) => set.map((setToken) => rackTile(state, actor, setToken)));
	const used = melds.flat();
	if (used.length !== FINISH_TILES || new Set(used).size !== FINISH_TILES || used.includes(tile)) fail('invalid_meld');
	const okey = okeyFaceOf(state.indicator);
	const pairs = melds.every((meld) => meld.length === 2);
	const valid = pairs
		? melds.length === FINISH_PAIRS && validatePairs(melds, okey)
		: melds.every((meld) => validateSet(meld, okey) !== null);
	if (!valid) fail('invalid_meld');
	return {
		...throwTile(state, actor, tile),
		result: {
			kind: 'win',
			winners: [actor],
			reason: 'finish',
			finish: isOkey(tile, okey) ? 'okey' : pairs ? 'pairs' : 'normal',
		},
	};
}

// Timeouts never throw the okey away when another tile is there.
function autoDiscardTile(rack: ReadonlyArray<number>, preferred: number, okey: OkeyFace): number {
	return isOkey(preferred, okey) ? (rack.find((tile) => !isOkey(tile, okey)) ?? preferred) : preferred;
}

export const ClassicOkey: TableGameEngine<ClassicOkeyState> = {
	kind: 'okey',
	positions: POSITIONS,

	start(positions, rng, clock) {
		if (positions.length !== POSITIONS.length || POSITIONS.some((position) => !positions.includes(position))) {
			throw new Error('classic okey needs all four positions');
		}
		const {indicator, rest} = pickIndicator(newDeck(rng), rng);
		const starter = POSITIONS[rng.int(POSITIONS.length)]!;
		const racks: Array<Array<number>> = [];
		let dealt = 0;
		for (let offset = 0; offset < POSITIONS.length; offset++) {
			const size = offset === 0 ? OTHERS_DEAL + 1 : OTHERS_DEAL;
			racks[(starter - 1 + offset) % POSITIONS.length] = rest.slice(dealt, dealt + size);
			dealt += size;
		}
		return {
			indicator,
			pile: rest.slice(dealt),
			racks,
			discards: POSITIONS.map(() => []),
			turn: starter,
			phase: 'discard', // the starter throws without drawing (Ek A 5)
			lastReceived: racks[starter - 1]!.at(-1)!,
			deadlineAt: clock.now + clock.turnMs,
			timeouts: POSITIONS.map(() => 0),
			turns: 0,
			result: null,
		};
	},

	apply(state, actor, action: TableGameAction, _rng, clock) {
		if (state.result !== null) fail('game_over');
		switch (action.type) {
			case 'draw':
				return resetTimeouts(draw(state, actor, action.from), actor);
			case 'discard':
				return resetTimeouts(discard(state, actor, action.tile, clock), actor);
			case 'finish':
				return resetTimeouts(finish(state, actor, action.tile, action.sets), actor);
			default:
				return fail('unsupported_action');
		}
	},

	onDeadline(state, _rng, clock) {
		if (state.result !== null) return state;
		const actor = state.turn;
		const count = state.timeouts[actor - 1]! + 1;
		const counted = {...state, timeouts: replaceAt(state.timeouts, actor - 1, count)};
		if (count >= TABLE_GAME_MAX_CONSECUTIVE_TIMEOUTS) {
			return {...counted, result: {kind: 'forfeit', loser: actor, reason: 'timeouts'}};
		}
		const holding = state.phase === 'draw' ? draw(counted, actor, 'pile') : counted;
		const tile = autoDiscardTile(holding.racks[actor - 1]!, holding.lastReceived!, okeyFaceOf(state.indicator));
		return passTurn(throwTile(holding, actor, tile), clock);
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
			game: 'okey',
			indicator: okeyTileToken(state.indicator),
			pile_count: state.pile.length,
			discards: state.discards.map((pile) => pile.map(okeyTileToken)),
			rack_counts: state.racks.map((rack) => rack.length),
			turn: ended ? null : state.turn,
			phase: state.phase,
			deadline_at: ended ? null : new Date(state.deadlineAt).toISOString(),
			rack: viewer === null ? null : state.racks[viewer - 1]!.map(okeyTileToken),
		};
	},
};
