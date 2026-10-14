// SPDX-License-Identifier: AGPL-3.0-or-later

import {isOkey, type OkeyFace, tileFace} from '@app/api/table_game/engine/okey/OkeyDeck';

export type OkeySetKind = 'run' | 'group';
export type OkeyMeldKind = OkeySetKind | 'pair';

// Runs are read in the given order, ascending; a wild okey stands for the number of its position.
// A 1 may close a run after 13 (12-13-1) and is worth 1 there. A set that is both a valid group and
// a valid run (one real tile and two okeys) is a group.
export function validateSet(tiles: ReadonlyArray<number>, okey: OkeyFace): {kind: OkeySetKind; value: number} | null {
	const group = groupValue(tiles, okey);
	if (group !== null) return {kind: 'group', value: group};
	const run = runValue(tiles, okey);
	return run === null ? null : {kind: 'run', value: run};
}

export function validatePairs(pairs: ReadonlyArray<ReadonlyArray<number>>, okey: OkeyFace): boolean {
	return pairs.length > 0 && pairs.every((pair) => isPair(pair, okey));
}

export function canExtend(
	meld: {readonly kind: OkeyMeldKind; readonly tiles: ReadonlyArray<number>},
	tiles: ReadonlyArray<number>,
	at: 'start' | 'end',
	okey: OkeyFace,
): boolean {
	if (tiles.length === 0) return false;
	const joined = at === 'start' ? [...tiles, ...meld.tiles] : [...meld.tiles, ...tiles];
	if (meld.kind === 'run') return runValue(joined, okey) !== null;
	if (meld.kind === 'group') return groupValue(joined, okey) !== null;
	return false;
}

function isPair(pair: ReadonlyArray<number>, okey: OkeyFace): boolean {
	if (pair.length !== 2) return false;
	const [a, b] = pair as [number, number];
	if (isOkey(a, okey) || isOkey(b, okey)) return true;
	const faceA = tileFace(a, okey);
	const faceB = tileFace(b, okey);
	return faceA.color === faceB.color && faceA.number === faceB.number;
}

function groupValue(tiles: ReadonlyArray<number>, okey: OkeyFace): number | null {
	if (tiles.length < 3 || tiles.length > 4) return null;
	let number = 0;
	const colors = new Set<number>();
	for (const tile of tiles) {
		if (isOkey(tile, okey)) continue;
		const face = tileFace(tile, okey);
		if ((number !== 0 && face.number !== number) || colors.has(face.color)) return null;
		number = face.number;
		colors.add(face.color);
	}
	return number === 0 ? null : number * tiles.length;
}

// Positions run 1..14 where 14 is the 1 that follows 13.
function runValue(tiles: ReadonlyArray<number>, okey: OkeyFace): number | null {
	if (tiles.length < 3 || tiles.length > 13) return null;
	const anchorIndex = tiles.findIndex((tile) => !isOkey(tile, okey));
	if (anchorIndex === -1) return null;
	const anchor = tileFace(tiles[anchorIndex]!, okey);
	const starts = anchor.number === 1 ? [1 - anchorIndex, 14 - anchorIndex] : [anchor.number - anchorIndex];
	for (const start of starts) {
		if (start < 1 || start + tiles.length - 1 > 14) continue;
		const fits = tiles.every((tile, index) => {
			if (isOkey(tile, okey)) return true;
			const face = tileFace(tile, okey);
			const position = start + index;
			return face.color === anchor.color && face.number === (position === 14 ? 1 : position);
		});
		if (fits) {
			let value = 0;
			for (let index = 0; index < tiles.length; index++) value += start + index === 14 ? 1 : start + index;
			return value;
		}
	}
	return null;
}
