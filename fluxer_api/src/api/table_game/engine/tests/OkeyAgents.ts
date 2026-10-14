// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ClassicOkeyState} from '@app/api/table_game/engine/okey/ClassicOkey';
import {isOkey, type OkeyFace, okeyFaceOf, tileFace} from '@app/api/table_game/engine/okey/OkeyDeck';
import type {TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {okeyTileToken} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// Classic Okey test agent. Deterministic: its "random" choices are seeded from the position it sees,
// and every action it returns is legal under the Classic Okey rules. (The 101 greedy test player lives with Okey101.)

const TIMEOUT_ODDS = 25; // about 1 move in 25 is left to time out
const DISCARD_DRAW_ODDS = 8;
const DISCARD_DRAW_TURN_BUDGET = 56; // keeps every classic game under 60 turns (each turn eats a pile tile otherwise)

const token = okeyTileToken;

function choiceRng(...parts: Array<number>): SeededRng {
	let seed = 0x9e3779b9;
	for (const part of parts) seed = Math.imul(seed ^ part, 0x85ebca6b) >>> 0;
	return new SeededRng(seed);
}

const faceIndex = (face: OkeyFace) => face.color * 13 + face.number - 1;

// A tile with no same-color neighbour within 2 and no same-number partner helps no set.
function isolatedTiles(rack: ReadonlyArray<number>, okey: OkeyFace): Array<number> {
	const faces = rack.filter((tile) => !isOkey(tile, okey)).map((tile) => ({tile, face: tileFace(tile, okey)}));
	return faces
		.filter(({tile, face}) =>
			faces.every(
				(other) =>
					other.tile === tile ||
					(other.face.color === face.color
						? Math.abs(other.face.number - face.number) > 2 && Math.abs(other.face.number - face.number) < 11
						: other.face.number !== face.number),
			),
		)
		.map(({tile}) => tile);
}

export function randomOkeyAgent(state: ClassicOkeyState, actor: TablePosition): TableGameAction {
	const rack = state.racks[actor - 1]!;
	const rng = choiceRng(state.turns, state.pile.length, state.phase === 'draw' ? 1 : 2, ...rack);
	if (rng.int(TIMEOUT_ODDS) === 0) return {type: 'tick'};
	const okey = okeyFaceOf(state.indicator);
	if (state.phase === 'draw') {
		const offeredBy = ((actor + 2) % 4) + 1;
		const canTake = state.discards[offeredBy - 1]!.length > 0;
		const budget = state.turns + state.pile.length < DISCARD_DRAW_TURN_BUDGET;
		return {type: 'draw', from: canTake && budget && rng.int(DISCARD_DRAW_ODDS) === 0 ? 'discard' : 'pile'};
	}
	const finish = findFinish(rack, okey);
	if (finish !== null) {
		return {type: 'finish', tile: token(finish.tile), sets: finish.sets.map((set) => set.map(token))};
	}
	const isolated = isolatedTiles(rack, okey);
	const candidates = isolated.length > 0 ? isolated : rack.filter((tile) => !isOkey(tile, okey));
	return {type: 'discard', tile: token(candidates[rng.int(candidates.length)]!)};
}

const JOKER = -1;

// Finds a Classic Okey finish in a 15-tile rack: one tile to throw and the other 14 split into
// runs/groups (in ascending run order) or seven pairs. Exhaustive search, null when there is none.
export function findFinish(
	rack: ReadonlyArray<number>,
	okey: OkeyFace,
): {tile: number; sets: Array<Array<number>>} | null {
	const counts = new Array<number>(52).fill(0);
	const jokers = rack.filter((tile) => isOkey(tile, okey));
	for (const tile of rack) if (!isOkey(tile, okey)) counts[faceIndex(tileFace(tile, okey))]!++;
	const pieces = solveSets(counts, jokers.length) ?? solvePairs(counts, jokers.length);
	if (pieces === null) return null;
	const pool = new Map<number, Array<number>>();
	for (const tile of rack) {
		const key = isOkey(tile, okey) ? JOKER : faceIndex(tileFace(tile, okey));
		pool.set(key, [...(pool.get(key) ?? []), tile]);
	}
	const take = (piece: number) => pool.get(piece)!.pop()!;
	const sets = pieces.sets.map((set) => set.map(take));
	return {tile: take(pieces.leftover), sets};
}

interface Pieces {
	sets: Array<Array<number>>;
	leftover: number;
}

function solveSets(counts: Array<number>, jokerCount: number): Pieces | null {
	const sets: Array<Array<number>> = [];
	let leftover = JOKER;

	const solve = (jokers: number, leftoverFree: boolean): boolean => {
		const first = counts.findIndex((count) => count > 0);
		if (first === -1) {
			if (jokers === 0) return !leftoverFree;
			if (jokers === 1 && leftoverFree) {
				leftover = JOKER;
				return true;
			}
			return false;
		}
		const color = Math.floor(first / 13);
		const number = (first % 13) + 1;
		counts[first]!--;
		if (leftoverFree) {
			leftover = first;
			if (solve(jokers, false)) return true;
		}
		if (tryGroups(first, color, number, jokers, leftoverFree)) return true;
		for (let lead = 0; lead <= Math.min(jokers, number - 1); lead++) {
			if (extendUp(color, number, [...new Array<number>(lead).fill(JOKER), first], jokers - lead, leftoverFree)) {
				return true;
			}
		}
		if (number === 1 && extendDown(color, 14, [first], jokers, leftoverFree)) return true;
		counts[first]!++;
		return false;
	};

	const closeSet = (set: Array<number>, jokers: number, leftoverFree: boolean): boolean => {
		sets.push(set);
		if (solve(jokers, leftoverFree)) return true;
		sets.pop();
		return false;
	};

	const tryGroups = (first: number, color: number, number: number, jokers: number, leftoverFree: boolean): boolean => {
		const partners: Array<number> = [];
		for (let other = color + 1; other < 4; other++) {
			if (counts[other * 13 + number - 1]! > 0) partners.push(other * 13 + number - 1);
		}
		for (let mask = 0; mask < 1 << partners.length; mask++) {
			const chosen = partners.filter((_, bit) => mask & (1 << bit));
			for (let wild = 0; wild <= jokers; wild++) {
				const size = 1 + chosen.length + wild;
				if (size < 3 || size > 4) continue;
				for (const face of chosen) counts[face]!--;
				if (closeSet([first, ...chosen, ...new Array<number>(wild).fill(JOKER)], jokers - wild, leftoverFree)) {
					return true;
				}
				for (const face of chosen) counts[face]!++;
			}
		}
		return false;
	};

	// Positions 1..14 (14 = the 1 after 13); `run` is ascending and ends at `top`.
	const extendUp = (color: number, top: number, run: Array<number>, jokers: number, leftoverFree: boolean): boolean => {
		if (run.length >= 3 && closeSet([...run], jokers, leftoverFree)) return true;
		const position = top + 1;
		if (position > 14 || run.length >= 13) return false;
		const face = color * 13 + (position === 14 ? 0 : position - 1);
		if (counts[face]! > 0) {
			counts[face]!--;
			if (extendUp(color, position, [...run, face], jokers, leftoverFree)) return true;
			counts[face]!++;
		}
		return jokers > 0 && extendUp(color, position, [...run, JOKER], jokers - 1, leftoverFree);
	};

	// Runs that end with the 1 after 13 (…12-13-1); `run` is ascending and starts at `bottom`.
	const extendDown = (
		color: number,
		bottom: number,
		run: Array<number>,
		jokers: number,
		leftoverFree: boolean,
	): boolean => {
		if (run.length >= 3 && closeSet([...run], jokers, leftoverFree)) return true;
		const position = bottom - 1;
		if (position < 2 || run.length >= 13) return false;
		const face = color * 13 + position - 1;
		if (counts[face]! > 0) {
			counts[face]!--;
			if (extendDown(color, position, [face, ...run], jokers, leftoverFree)) return true;
			counts[face]!++;
		}
		return jokers > 0 && extendDown(color, position, [JOKER, ...run], jokers - 1, leftoverFree);
	};

	return solve(jokerCount, true) ? {sets, leftover} : null;
}

function solvePairs(counts: ReadonlyArray<number>, jokers: number): Pieces | null {
	const candidates = [...counts.flatMap((count, face) => (count > 0 ? [face] : [])), ...(jokers > 0 ? [JOKER] : [])];
	for (const leftover of candidates) {
		const left = [...counts];
		let wild = jokers;
		if (leftover === JOKER) wild--;
		else left[leftover]!--;
		const sets: Array<Array<number>> = [];
		const singles: Array<number> = [];
		left.forEach((count, face) => {
			for (let k = 0; k + 1 < count; k += 2) sets.push([face, face]);
			if (count % 2 === 1) singles.push(face);
		});
		if (singles.length > wild || (wild - singles.length) % 2 !== 0) continue;
		for (const face of singles) sets.push([face, JOKER]);
		for (let k = singles.length; k < wild; k += 2) sets.push([JOKER, JOKER]);
		return {sets, leftover};
	}
	return null;
}
