// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RackSlot} from '@app/features/table_game/state/TableGames';
import {okeyTileFace, parseOkeyTileToken} from '@fluxer/constants/src/TableGameConstants';

// The rack is two rows of cells; a cell holds a tile token or is empty. 101 holds up to 22 tiles (+1 taken from
// the side), so 30 cells leave room for the gaps that separate sets.
export const RACK_COLUMNS = 15;
export const RACK_CELLS = RACK_COLUMNS * 2;

export interface OkeyFace {
	readonly color: 0 | 1 | 2 | 3;
	readonly number: number;
}

export interface OkeyTileLook {
	readonly face: OkeyFace; // what the tile plays as; a fake okey plays as the okey
	readonly okey: 'wild' | 'fake' | null;
}

// The okey is the indicator's color, one higher; the okey of a 13 is the 1.
export function okeyFaceOf(indicator: string): OkeyFace | null {
	const id = parseOkeyTileToken(indicator);
	if (id === null) return null;
	const face = okeyTileFace(id);
	if ('fake' in face) return null;
	return {color: face.color, number: face.number === 13 ? 1 : face.number + 1};
}

export function okeyTileLook(token: string, okey: OkeyFace | null): OkeyTileLook | null {
	const id = parseOkeyTileToken(token);
	if (id === null) return null;
	const face = okeyTileFace(id);
	if ('fake' in face) return okey ? {face: okey, okey: 'fake'} : null;
	const wild = okey !== null && face.color === okey.color && face.number === okey.number;
	return {face, okey: wild ? 'wild' : null};
}

// The stored order (tiles and the gaps the player left) laid on the cells; surplus gaps go from the end first.
export function layoutRack(order: ReadonlyArray<RackSlot>): Array<RackSlot> {
	const cells = [...order];
	for (let index = cells.length - 1; cells.length > RACK_CELLS && index >= 0; index--) {
		if (cells[index] === null) cells.splice(index, 1);
	}
	while (cells.length < RACK_CELLS) cells.push(null);
	return cells;
}

// Dropping on an empty cell moves the tile; dropping on a tile swaps the two.
export function moveRackTile(cells: ReadonlyArray<RackSlot>, from: number, to: number): Array<RackSlot> {
	const next = [...cells];
	next[from] = cells[to] ?? null;
	next[to] = cells[from] ?? null;
	return next;
}

export function trimRack(cells: ReadonlyArray<RackSlot>): Array<RackSlot> {
	let end = cells.length;
	while (end > 0 && cells[end - 1] === null) end--;
	return cells.slice(0, end);
}

// Touching tiles form a set; an empty cell or the end of a row closes it. `exclude` (the finishing tile) is skipped
// without splitting its set. Sets are read left to right, as the player laid them (runs only count ascending).
export function rackGroups(cells: ReadonlyArray<RackSlot>, exclude?: string): Array<Array<string>> {
	const groups: Array<Array<string>> = [];
	let current: Array<string> = [];
	const close = () => {
		if (current.length > 0) groups.push(current);
		current = [];
	};
	cells.forEach((tile, index) => {
		if (index % RACK_COLUMNS === 0) close();
		if (tile === null) close();
		else if (tile !== exclude) current.push(tile);
	});
	close();
	return groups;
}
