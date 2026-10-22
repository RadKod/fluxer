// SPDX-License-Identifier: AGPL-3.0-or-later

import type {NoteGroup, TimeSpan} from '@app/features/activities/band/engine/ChartModel';

// Rock Band marks free play with notes 120..124 on each instrument track; scan-chart reads them as freestyle sections
// and flags the ones at or after the EVENTS "[coda]" text. Earlier ones are drum fills; a coda one is the Big Rock
// Ending: the part's notes under it give way to free play, and its first note after the lanes is the final hit.
// Charts without "[coda]" get no ending: nothing else in a chart says where free play would start.
export interface BigRockEnding {
	readonly startMs: number;
	// Where the free-play lanes end; the final hit follows shortly after.
	readonly endMs: number;
}

export interface FreestyleSpan extends TimeSpan {
	readonly isCoda: boolean;
}

export function codaSpan(fills: ReadonlyArray<FreestyleSpan>): TimeSpan | null {
	const coda = fills.find((fill) => fill.isCoda && fill.length > 0);
	if (!coda) return null;
	const {tick, length, msTime, msLength} = coda;
	return {tick, length, msTime, msLength};
}

// One part's ending, by index into its note groups.
export interface PartFinale extends BigRockEnding {
	// First group under the lanes; groups from here up to the final hit are free play.
	readonly firstIndex: number;
	// The part's first group after the lanes, else its last one when that is under them; null when the part plays
	// nothing from the lanes on.
	readonly finalIndex: number | null;
}

export function partFinale(span: TimeSpan | null, groups: ReadonlyArray<NoteGroup>): PartFinale | null {
	if (!span) return null;
	const endTick = span.tick + span.length;
	let firstIndex = groups.findIndex((group) => group.tick >= span.tick);
	if (firstIndex < 0) firstIndex = groups.length;
	const after = groups.findIndex((group) => group.tick >= endTick);
	const lastIndex = groups.length - 1;
	const finalIndex = after >= 0 ? after : lastIndex >= firstIndex ? lastIndex : null;
	return {startMs: span.msTime, endMs: span.msTime + span.msLength, firstIndex, finalIndex};
}

export function isFreePlayGroup(finale: PartFinale | null, index: number): boolean {
	return finale !== null && index >= finale.firstIndex && (finale.finalIndex === null || index < finale.finalIndex);
}
