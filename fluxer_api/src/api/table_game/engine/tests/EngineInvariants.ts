// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Rng, TableGameEngine, TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {okeyTileToken, TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameAction, TableGameView} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Where an okey-family state keeps its tiles (ids). Classic Okey and 101 states both have this shape.
export interface OkeyTiles {
	readonly indicator: number;
	readonly pile: ReadonlyArray<number>;
	readonly racks: ReadonlyArray<ReadonlyArray<number>>;
	readonly discards: ReadonlyArray<ReadonlyArray<number>>;
	readonly melds?: ReadonlyArray<{readonly tiles: ReadonlyArray<number>}>;
}

export const GAME_START_MS = Date.parse('2026-10-03T12:00:00.000Z');
const STEP_MS = 1_000;
const MAX_STEPS = 10_000;

// Plays one game to the end. The agent picks each move of the player to act; an agent that answers
// {type: 'tick'} lets that player's deadline pass instead, so timeouts run through engine.onDeadline.
export function playRandomGame<S>(
	engine: TableGameEngine<S>,
	rng: Rng,
	agent: (state: S, actor: TablePosition) => TableGameAction,
	onStep: (state: S) => void,
): S {
	const turnMs = TABLE_GAME_TURN_MS[engine.kind].normal;
	let now = GAME_START_MS;
	let state = engine.start(engine.positions, rng, {now, turnMs});
	onStep(state);
	for (let step = 0; engine.result(state) === null; step++) {
		if (step >= MAX_STEPS) throw new Error(`game did not end within ${MAX_STEPS} steps`);
		const actor = actorToMove(engine.view(state, null));
		const action = agent(state, actor);
		now += STEP_MS;
		if (action.type === 'tick') {
			now = Math.max(now, engine.deadline(state) ?? now);
			state = engine.onDeadline(state, rng, {now, turnMs});
		} else {
			state = engine.apply(state, actor, action, rng, {now, turnMs});
		}
		onStep(state);
	}
	return state;
}

export function actorToMove(view: TableGameView['game_view']): TablePosition {
	if (view === null) throw new Error('no game view while playing');
	if (view.game === 'chess') {
		const whiteToMove = view.fen.split(' ')[1] === 'w';
		return whiteToMove ? view.white : view.white === 1 ? 3 : 1;
	}
	if (view.turn === null) throw new Error('nobody to act in a running game');
	return view.turn as TablePosition;
}

// Every tile token ("t0".."t105") that appears as a word anywhere in the text.
export function tokensIn(json: string): Set<string> {
	return new Set(json.match(/\bt\d+\b/g) ?? []);
}

export function rackTokensOf(state: OkeyTiles, position: TablePosition): Array<string> {
	return state.racks[position - 1]!.map(okeyTileToken);
}

export function deckTokensOf(state: OkeyTiles): Array<string> {
	return state.pile.map(okeyTileToken);
}

export function assertTileConservation(state: OkeyTiles): void {
	const tiles = [
		state.indicator,
		...state.pile,
		...state.racks.flat(),
		...state.discards.flat(),
		...(state.melds ?? []).flatMap((meld) => meld.tiles),
	];
	const distinct = new Set(tiles);
	if (
		tiles.length !== 106 ||
		distinct.size !== 106 ||
		tiles.some((tile) => !Number.isInteger(tile) || tile < 0 || tile > 105)
	) {
		throw new Error(`tile conservation broken: ${tiles.length} tiles, ${distinct.size} distinct`);
	}
}
