// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Rng} from '@app/api/table_game/engine/TableGameEngine';
import {okeyTileFace} from '@fluxer/constants/src/TableGameConstants';

// Tiles are the ids of TableGameConstants (t0..t105); racks, piles and melds hold ids, tokens only at the edges.
export const OKEY_TILE_COUNT = 106;

export interface OkeyFace {
	readonly color: 0 | 1 | 2 | 3;
	readonly number: number;
}

export function newDeck(rng: Rng): Array<number> {
	const deck = Array.from({length: OKEY_TILE_COUNT}, (_, id) => id);
	for (let i = deck.length - 1; i > 0; i--) {
		const j = rng.int(i + 1);
		[deck[i], deck[j]] = [deck[j]!, deck[i]!];
	}
	return deck;
}

export function pickIndicator(deck: ReadonlyArray<number>, rng: Rng): {indicator: number; rest: Array<number>} {
	for (;;) {
		const index = rng.int(deck.length);
		const indicator = deck[index]!;
		if (!isFakeOkey(indicator)) {
			return {indicator, rest: [...deck.slice(0, index), ...deck.slice(index + 1)]};
		}
	}
}

export function okeyFaceOf(indicator: number): OkeyFace {
	const face = realFace(indicator);
	return {color: face.color, number: face.number === 13 ? 1 : face.number + 1};
}

// The two real tiles carrying the okey face are wild; the fake okeys are not.
export function isOkey(tile: number, okey: OkeyFace): boolean {
	if (isFakeOkey(tile)) return false;
	const face = realFace(tile);
	return face.color === okey.color && face.number === okey.number;
}

// The face a tile plays as: a fake okey plays the okey face, every other tile its own.
export function tileFace(tile: number, okey: OkeyFace): OkeyFace {
	return isFakeOkey(tile) ? okey : realFace(tile);
}

function isFakeOkey(tile: number): boolean {
	return 'fake' in okeyTileFace(tile);
}

function realFace(tile: number): OkeyFace {
	const face = okeyTileFace(tile);
	if ('fake' in face) throw new Error('a fake okey has no face of its own');
	return face;
}
