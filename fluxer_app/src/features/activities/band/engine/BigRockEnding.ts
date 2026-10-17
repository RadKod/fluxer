// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChartSection} from '@app/features/activities/band/engine/SongChart';

// Rock Band marks drum fills with notes 120..124 on PART DRUMS; scan-chart reads them as freestyle sections and flags
// the ones at or after the EVENTS "[coda]" text. A coda fill is the Big Rock Ending: free play, then one final hit.
export interface BigRockEnding {
	readonly startMs: number;
	// The final hit everyone plays together.
	readonly endMs: number;
}

export interface FreestyleSpan {
	readonly msTime: number;
	readonly msLength: number;
	readonly isCoda: boolean;
}

// Shorter fills are star power activation lanes, which charts also put near the end of a song.
export const BIG_ROCK_ENDING_MIN_MS = 2_000;
// Without a "[coda]" text, a long fill counts when at most this much charting follows it.
export const BIG_ROCK_ENDING_TAIL_MS = 3_000;

export function findBigRockEnding(
	fills: ReadonlyArray<FreestyleSpan>,
	sections: ReadonlyArray<ChartSection>,
	lastNoteMs: number,
): BigRockEnding | null {
	const coda = fills.find((fill) => fill.isCoda && fill.msLength > 0);
	if (coda) return {startMs: coda.msTime, endMs: coda.msTime + coda.msLength};

	const last = fills.reduce<FreestyleSpan | null>(
		(latest, fill) => (latest === null || fill.msTime > latest.msTime ? fill : latest),
		null,
	);
	if (!last || last.msLength < BIG_ROCK_ENDING_MIN_MS) return null;
	const endMs = last.msTime + last.msLength;
	const finalSectionMs = sections.at(-1)?.msTime ?? 0;
	if (last.msTime < finalSectionMs || lastNoteMs > endMs + BIG_ROCK_ENDING_TAIL_MS) return null;
	return {startMs: last.msTime, endMs};
}
