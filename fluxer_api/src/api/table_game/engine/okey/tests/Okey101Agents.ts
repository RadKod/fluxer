// SPDX-License-Identifier: AGPL-3.0-or-later

import {type Okey101State, setPoints} from '@app/api/table_game/engine/okey/Okey101';
import {OKEY101_RULES} from '@app/api/table_game/engine/okey/Okey101Rules';
import {isOkey, type OkeyFace, okeyFaceOf, tileFace} from '@app/api/table_game/engine/okey/OkeyDeck';
import {canExtend, validateSet} from '@app/api/table_game/engine/okey/OkeyMelds';
import type {TablePosition} from '@app/api/table_game/engine/TableGameEngine';
import {SeededRng} from '@app/api/table_game/engine/tests/SeededRng';
import {okeyTileToken} from '@fluxer/constants/src/TableGameConstants';
import type {TableGameAction} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';

// 101 test agent. Greedy: it opens as soon as its runs/groups reach the minimum or it holds
// enough pairs, then lays new melds of its kind and adds what fits, taking a discard whenever it can lay it
// down. Its other choices (timeouts, which tile to throw, an occasional penalty throw) are seeded from the
// position it sees, so a seed replays a whole game. Every action it returns is legal under the 101 Okey rules.

const TIMEOUT_ODDS = 25; // about 1 move in 25 is left to time out
const PENALTY_THROW_ODDS = 12; // about 1 throw in 12 ignores penalties

type Opened = Okey101State['opened'][number];
type Addition = NonNullable<Extract<TableGameAction, {type: 'meld'}>['add']>[number];

const token = okeyTileToken;

function choiceRng(...parts: Array<number>): SeededRng {
	let seed = 0x2545f491;
	for (const part of parts) seed = Math.imul(seed ^ part, 0x85ebca6b) >>> 0;
	return new SeededRng(seed);
}

export function greedyOkey101Agent(state: Okey101State, actor: TablePosition): TableGameAction {
	const rack = state.racks[actor - 1]!;
	const rng = choiceRng(state.turns, state.pile.length, state.melds.length, state.phase === 'draw' ? 1 : 2, ...rack);
	if (rng.int(TIMEOUT_ODDS) === 0) return {type: 'tick'};
	const okey = okeyFaceOf(state.indicator);
	if (state.phase === 'draw') return takeOrDraw(state, actor, okey);
	return layDown(state, actor, okey) ?? discard(state, actor, okey, rng);
}

function takeOrDraw(state: Okey101State, actor: TablePosition, okey: OkeyFace): TableGameAction {
	const taken = state.discards[(actor + 2) % 4]!.at(-1); // the previous position's last throw
	if (taken !== undefined) {
		const opened = state.opened[actor - 1]!;
		const addition = opened === 'none' ? null : additionFor(state, taken, okey);
		if (addition !== null) return {type: 'take_discard', add: [addition]};
		const plan = planMelds([...state.racks[actor - 1]!, taken], opened, okey);
		if (plan.some((set) => set.includes(taken))) return {type: 'take_discard', open: plan.map((set) => set.map(token))};
	}
	return {type: 'draw', from: 'pile'};
}

function layDown(state: Okey101State, actor: TablePosition, okey: OkeyFace): TableGameAction | null {
	const rack = state.racks[actor - 1]!;
	const opened = state.opened[actor - 1]!;
	const plan = planMelds(rack, opened, okey);
	if (plan.length > 0) return {type: 'meld', open: plan.map((set) => set.map(token))};
	if (opened === 'none' || state.openedAt[actor - 1] === state.turns || rack.length < 2) return null;
	for (const tile of rack) {
		const addition = additionFor(state, tile, okey);
		if (addition !== null) return {type: 'meld', add: [addition]};
	}
	return null;
}

function discard(state: Okey101State, actor: TablePosition, okey: OkeyFace, rng: SeededRng): TableGameAction {
	const rack = state.racks[actor - 1]!;
	const useful = new Set([...findSets(rack, okey).flat(), ...findPairs(rack, okey).flat()]);
	const safe = rack.filter((tile) => !isOkey(tile, okey) && additionFor(state, tile, okey) === null);
	const loose = safe.filter((tile) => !useful.has(tile));
	const pool = rng.int(PENALTY_THROW_ODDS) === 0 ? rack : loose.length > 0 ? loose : safe.length > 0 ? safe : rack;
	return {type: 'discard', tile: token(pool[rng.int(pool.length)]!)};
}

// What to lay down now: the opening if it reaches the minimum, later melds of the opening's kind; always
// leaving a tile to discard.
function planMelds(rack: ReadonlyArray<number>, opened: Opened, okey: OkeyFace): Array<Array<number>> {
	const sets = opened === 'pairs' ? [] : keepOneTile(findSets(rack, okey), rack.length);
	const pairs = opened === 'sets' ? [] : keepOneTile(findPairs(rack, okey), rack.length);
	if (opened === 'sets') return sets;
	if (opened === 'pairs') return pairs;
	const points = sets.reduce((sum, set) => sum + setPoints(set, okey)!, 0);
	if (points >= OKEY101_RULES.OPEN_MIN_POINTS) return sets;
	return pairs.length >= OKEY101_RULES.OPEN_MIN_PAIRS ? pairs : [];
}

function keepOneTile(melds: Array<Array<number>>, rackSize: number): Array<Array<number>> {
	const kept = [...melds];
	while (kept.flat().length >= rackSize) kept.pop();
	return kept;
}

function additionFor(state: Okey101State, tile: number, okey: OkeyFace): Addition | null {
	for (const [id, meld] of state.melds.entries()) {
		for (const at of ['start', 'end'] as const) {
			if (canExtend(meld, [tile], at, okey)) return {meld_id: id, tiles: [token(tile)], at};
		}
	}
	return null;
}

// Greedy: the longest runs per color (12-13-1 allowed), then groups, then okeys completing two-tile sets.
function findSets(rack: ReadonlyArray<number>, okey: OkeyFace): Array<Array<number>> {
	const free = rack.filter((tile) => !isOkey(tile, okey));
	const sets: Array<Array<number>> = [];
	const take = (set: Array<number>) => {
		sets.push(set);
		for (const tile of set) {
			const index = free.indexOf(tile);
			if (index !== -1) free.splice(index, 1);
		}
	};
	const find = (color: number, number: number, besides: ReadonlyArray<number> = []) =>
		free.find((tile) => {
			const face = tileFace(tile, okey);
			return face.color === color && face.number === number && !besides.includes(tile);
		});

	for (let color = 0; color < 4; color++) {
		let run: Array<number> = [];
		for (let position = 1; position <= 14; position++) {
			const tile = find(color, position === 14 ? 1 : position, run);
			if (tile !== undefined && run.length < 13) {
				run.push(tile);
				continue;
			}
			if (run.length >= 3) take(run);
			run = tile === undefined ? [] : [tile];
		}
		if (run.length >= 3) take(run);
	}
	for (let number = 1; number <= 13; number++) {
		const group = [0, 1, 2, 3].flatMap((color) => find(color, number) ?? []);
		if (group.length >= 3) take(group);
	}
	for (const joker of rack.filter((tile) => isOkey(tile, okey))) {
		const set = wildSet(free, joker, okey);
		if (set === null) break;
		take(set);
	}
	return sets.filter((set) => validateSet(set, okey) !== null);
}

function wildSet(free: ReadonlyArray<number>, joker: number, okey: OkeyFace): Array<number> | null {
	for (const a of free) {
		for (const b of free) {
			const faceA = tileFace(a, okey);
			const faceB = tileFace(b, okey);
			const gap = faceB.number - faceA.number;
			const near = faceA.color === faceB.color ? gap === 1 || gap === 2 : gap === 0;
			if (a === b || !near) continue;
			for (const set of [
				[a, b, joker],
				[a, joker, b],
			]) {
				if (validateSet(set, okey) !== null) return set;
			}
		}
	}
	return null;
}

// Identical faces pair up; okeys pair with the leftover singles.
function findPairs(rack: ReadonlyArray<number>, okey: OkeyFace): Array<Array<number>> {
	const waiting = new Map<number, number>();
	const pairs: Array<Array<number>> = [];
	for (const tile of rack) {
		if (isOkey(tile, okey)) continue;
		const face = tileFace(tile, okey);
		const key = face.color * 13 + face.number;
		const twin = waiting.get(key);
		if (twin === undefined) {
			waiting.set(key, tile);
		} else {
			pairs.push([twin, tile]);
			waiting.delete(key);
		}
	}
	const singles = [...waiting.values()];
	for (const joker of rack.filter((tile) => isOkey(tile, okey))) {
		const single = singles.shift();
		if (single !== undefined) pairs.push([single, joker]);
	}
	return pairs;
}
