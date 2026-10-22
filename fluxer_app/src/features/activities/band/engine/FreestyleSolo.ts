// SPDX-License-Identifier: AGPL-3.0-or-later

// Rock Band 4 style freestyle solos: a charted solo section is played freely in the song's key, and instead of notes
// the highway shows cues for how to play it. The cues come from the charted solo itself, so they follow its shape:
// where it climbs the neck, where it holds a note, where it runs fast or taps.

import type {PartFinale} from '@app/features/activities/band/engine/BigRockEnding';
import {
	type BandPart,
	FretLane,
	type InstrumentPart,
	type NoteGroup,
	type PartChart,
} from '@app/features/activities/band/engine/ChartModel';
import type {ChartSection} from '@app/features/activities/band/engine/SongChart';

// Parts whose solo sections can be played freestyle; their freestyle voice is the lead guitar or the keys.
export const FREESTYLE_PARTS: ReadonlyArray<InstrumentPart> = ['guitar', 'rhythm', 'keys'];

export function isFreestylePart(part: BandPart): part is InstrumentPart {
	return (FREESTYLE_PARTS as ReadonlyArray<BandPart>).includes(part);
}

// solid, striped, dotted and star field on the highway.
export type SoloCueStyle = 'sustain' | 'strum' | 'tap' | 'free';
// Blue band over the right-hand lanes, orange band over the left-hand ones.
export type SoloCueRegion = 'high' | 'low';

export interface SoloCue {
	readonly startMs: number;
	readonly endMs: number;
	readonly style: SoloCueStyle;
	// Null for free play, which takes any lane.
	readonly region: SoloCueRegion | null;
	// Charted note groups under the cue; the scorer pays about as many presses as the chart has notes.
	readonly notes: number;
}

export interface SoloSection {
	readonly startMs: number;
	readonly endMs: number;
	// The part's note groups [firstIndex, endIndex) fall in the section; none of them is judged.
	readonly firstIndex: number;
	readonly endIndex: number;
	// Back to back from startMs to endMs.
	readonly cues: ReadonlyArray<SoloCue>;
}

export interface SoloSpan {
	readonly startMs: number;
	readonly endMs: number;
}

export const SOLO_CUE = {
	// A single note held this long is a sustain cue.
	sustainMs: 400,
	// Notes this close to a neighbour are a fast run: strummed, or tapped when the chart marks them as taps.
	fastGapMs: 180,
	// A cue shorter than this is folded into its neighbour; nobody can follow a cue that flickers.
	minCueMs: 600,
} as const;

// A solo with fewer notes than this is a lick, not a section worth handing over.
export const MIN_SOLO_GROUPS = 4;

const SOLO_SECTION_NAME = /solo/i;

// Section names like "guitar_solo" or "Guitar Solo 2", from where one starts to the next section; contiguous ones
// merge. The same fallback the key analysis (ton-bul.py) uses when a chart has no solo markers.
function namedSoloSpans(sections: ReadonlyArray<ChartSection>, songEndMs: number): Array<SoloSpan> {
	const sorted = [...sections].sort((a, b) => a.msTime - b.msTime);
	const spans: Array<SoloSpan> = [];
	sorted.forEach((section, index) => {
		if (!SOLO_SECTION_NAME.test(section.name)) return;
		const endMs = sorted[index + 1]?.msTime ?? songEndMs;
		if (endMs <= section.msTime) return;
		const previous = spans.at(-1);
		if (previous && previous.endMs === section.msTime) spans[spans.length - 1] = {...previous, endMs};
		else spans.push({startMs: section.msTime, endMs});
	});
	return spans;
}

// The part's own solo markers (note 103 in .mid, solo/soloend in .chart). Only the lead guitar falls back to solo
// sections named in EVENTS: those name the guitar solo, rarely a rhythm or keys one.
export function soloSpans(chart: PartChart, sections: ReadonlyArray<ChartSection>): Array<SoloSpan> {
	if (chart.solos.length > 0) {
		return chart.solos.map((span) => ({startMs: span.msTime, endMs: span.msTime + span.msLength}));
	}
	return chart.part === 'guitar' ? namedSoloSpans(sections, chart.durationMs) : [];
}

function firstGroupAtOrAfter(groups: ReadonlyArray<NoteGroup>, ms: number, from = 0): number {
	let index = from;
	while (index < groups.length && groups[index].msTime < ms) index++;
	return index;
}

// The part's freestyle sections; a solo running into the Big Rock Ending stops where the ending's free play starts.
export function freestyleSections(
	chart: PartChart,
	sections: ReadonlyArray<ChartSection>,
	finale: PartFinale | null = null,
): Array<SoloSection> {
	const result: Array<SoloSection> = [];
	for (const span of soloSpans(chart, sections)) {
		const endMs = finale ? Math.min(span.endMs, finale.startMs) : span.endMs;
		const firstIndex = firstGroupAtOrAfter(chart.groups, span.startMs);
		const endIndex = firstGroupAtOrAfter(chart.groups, endMs, firstIndex);
		if (endIndex - firstIndex < MIN_SOLO_GROUPS) continue;
		const previous = result.at(-1);
		if (previous && previous.endMs > span.startMs) continue;
		result.push({
			startMs: span.startMs,
			endMs,
			firstIndex,
			endIndex,
			cues: deriveSoloCues(chart.groups, firstIndex, endIndex, span.startMs, endMs),
		});
	}
	return result;
}

// Lane height of a group; the open note sits under green.
function groupPitch(group: NoteGroup): number {
	return group.lanes.reduce((sum, lane) => sum + (lane === FretLane.Open ? -1 : lane), 0) / group.lanes.length;
}

function groupStyle(groups: ReadonlyArray<NoteGroup>, index: number, firstIndex: number, endIndex: number) {
	const group = groups[index];
	if (group.msLength >= SOLO_CUE.sustainMs && group.lanes.length === 1) return 'sustain';
	const previousGap = index > firstIndex ? group.msTime - groups[index - 1].msTime : Number.POSITIVE_INFINITY;
	const nextGap = index + 1 < endIndex ? groups[index + 1].msTime - group.msTime : Number.POSITIVE_INFINITY;
	if (group.isTap) return 'tap';
	return Math.min(previousGap, nextGap) <= SOLO_CUE.fastGapMs ? 'strum' : 'free';
}

interface CueRun {
	style: SoloCueStyle;
	region: SoloCueRegion | null;
	startMs: number;
	notes: number;
}

function sameCue(a: CueRun, b: CueRun): boolean {
	return a.style === b.style && a.region === b.region;
}

// Neighbouring runs with the same cue become one.
function coalesce(runs: Array<CueRun>): Array<CueRun> {
	const out: Array<CueRun> = [];
	for (const run of runs) {
		const previous = out.at(-1);
		if (previous && sameCue(previous, run)) previous.notes += run.notes;
		else out.push({...run});
	}
	return out;
}

// High and low are relative to the solo's own average, so a solo played all over the top of the neck still has
// its climbs and drops; free play has no region.
export function deriveSoloCues(
	groups: ReadonlyArray<NoteGroup>,
	firstIndex: number,
	endIndex: number,
	startMs: number,
	endMs: number,
): Array<SoloCue> {
	if (endIndex <= firstIndex) return [{startMs, endMs, style: 'free', region: null, notes: 0}];
	let pitchSum = 0;
	for (let index = firstIndex; index < endIndex; index++) pitchSum += groupPitch(groups[index]);
	const centre = pitchSum / (endIndex - firstIndex);

	let runs: Array<CueRun> = [];
	for (let index = firstIndex; index < endIndex; index++) {
		const style = groupStyle(groups, index, firstIndex, endIndex);
		const region = style === 'free' ? null : groupPitch(groups[index]) >= centre ? 'high' : 'low';
		runs.push({style, region, startMs: index === firstIndex ? startMs : groups[index].msTime, notes: 1});
	}
	runs = coalesce(runs);

	const lengthOf = (at: number) => (runs[at + 1]?.startMs ?? endMs) - runs[at].startMs;
	while (runs.length > 1) {
		let shortest = -1;
		for (let at = 0; at < runs.length; at++) {
			if (lengthOf(at) < SOLO_CUE.minCueMs && (shortest < 0 || lengthOf(at) < lengthOf(shortest))) shortest = at;
		}
		if (shortest < 0) break;
		const run = runs[shortest];
		// Folded into the neighbour it already matches, else into the one before it (the one after for the first).
		const into = runs[shortest + 1] && sameCue(runs[shortest + 1], run) ? shortest + 1 : Math.max(0, shortest - 1);
		const target = into === shortest ? shortest + 1 : into;
		runs[target].notes += run.notes;
		runs[target].startMs = Math.min(runs[target].startMs, run.startMs);
		runs.splice(shortest, 1);
		runs = coalesce(runs);
	}
	return runs.map((run, at) => ({
		startMs: run.startMs,
		endMs: runs[at + 1]?.startMs ?? endMs,
		style: run.style,
		region: run.region,
		notes: run.notes,
	}));
}

export function soloSectionAt(sections: ReadonlyArray<SoloSection>, ms: number): SoloSection | null {
	return sections.find((section) => ms >= section.startMs && ms < section.endMs) ?? null;
}

export function soloCueAt(section: SoloSection, ms: number): SoloCue | null {
	return section.cues.find((cue) => ms >= cue.startMs && ms < cue.endMs) ?? null;
}

export function isFreestyleGroup(sections: ReadonlyArray<SoloSection>, index: number): boolean {
	return sections.some((section) => index >= section.firstIndex && index < section.endIndex);
}
