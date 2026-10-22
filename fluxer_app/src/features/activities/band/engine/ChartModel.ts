// SPDX-License-Identifier: AGPL-3.0-or-later

import {codaSpan} from '@app/features/activities/band/engine/BigRockEnding';
import {noteFlags, noteTypes} from '@app/features/activities/band/engine/vendor/scan-chart/note-parsing-interfaces';
import type {ParsedChart} from '@app/features/activities/band/engine/vendor/scan-chart/notes-parser';

export type BandPart = 'guitar' | 'rhythm' | 'bass' | 'drums' | 'keys' | 'vocals';
export type InstrumentPart = Exclude<BandPart, 'vocals'>;

// Left to right on the stage: the guitars, drums in the middle, bass, then keys.
export const STAGE_ORDER: ReadonlyArray<InstrumentPart> = ['guitar', 'rhythm', 'drums', 'bass', 'keys'];

// Parts that some songs split in two, mapped to the second part. With both charted the first one goes by its lead name
// ("Lead guitar"); harmony vocals or a second keys part would be added here the same way.
export const SECOND_PARTS: Readonly<Partial<Record<BandPart, BandPart>>> = {guitar: 'rhythm'};

export function isLeadPart(part: BandPart, parts: Partial<Record<BandPart, ReadonlyArray<unknown>>>): boolean {
	const second = SECOND_PARTS[part];
	return second !== undefined && (parts[second]?.length ?? 0) > 0;
}

export const BAND_DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'] as const;
export type BandDifficulty = (typeof BAND_DIFFICULTIES)[number];

export const FretLane = {Green: 0, Red: 1, Yellow: 2, Blue: 3, Orange: 4, Open: 5} as const;
export const FRET_LANE_COUNT = 5;

// Lane 0 is the kick pedal; 1..4 are pads left to right.
export const DrumLane = {Kick: 0, Red: 1, Yellow: 2, Blue: 3, Green: 4} as const;

export interface TimeSpan {
	readonly tick: number;
	// Length in ticks.
	readonly length: number;
	readonly msTime: number;
	readonly msLength: number;
}

// Everything that sounds on one tick; the judge scores a group as one hit.
export interface NoteGroup {
	readonly tick: number;
	readonly msTime: number;
	// Longest sustain in the group; 0 when nothing is held.
	readonly msLength: number;
	// Sorted, unique lane numbers (FretLane or DrumLane).
	readonly lanes: ReadonlyArray<number>;
	// Drum pad lanes charted as cymbals; always empty for fret parts.
	readonly cymbals: ReadonlyArray<number>;
	readonly isHopo: boolean;
	readonly isTap: boolean;
	readonly inStarPower: boolean;
	readonly inSolo: boolean;
}

export interface PartChart {
	readonly part: InstrumentPart;
	readonly difficulty: BandDifficulty;
	// True when generated from Expert by DifficultyDerivation instead of charted by hand.
	readonly derived: boolean;
	readonly groups: ReadonlyArray<NoteGroup>;
	readonly starPower: ReadonlyArray<TimeSpan>;
	readonly solos: ReadonlyArray<TimeSpan>;
	// The part's Big Rock Ending lanes; null when the chart has none (see BigRockEnding).
	readonly bigRockEnding: TimeSpan | null;
	readonly durationMs: number;
}

type ParsedTrack = ParsedChart['trackData'][number];

const FRET_LANE_BY_NOTE_TYPE: ReadonlyMap<number, number> = new Map([
	[noteTypes.open, FretLane.Open],
	[noteTypes.green, FretLane.Green],
	[noteTypes.red, FretLane.Red],
	[noteTypes.yellow, FretLane.Yellow],
	[noteTypes.blue, FretLane.Blue],
	[noteTypes.orange, FretLane.Orange],
]);

const DRUM_LANE_BY_NOTE_TYPE: ReadonlyMap<number, number> = new Map([
	[noteTypes.kick, DrumLane.Kick],
	[noteTypes.redDrum, DrumLane.Red],
	[noteTypes.yellowDrum, DrumLane.Yellow],
	[noteTypes.blueDrum, DrumLane.Blue],
	[noteTypes.greenDrum, DrumLane.Green],
]);

function toSpans(sections: ReadonlyArray<TimeSpan>): Array<TimeSpan> {
	return sections.map(({tick, length, msTime, msLength}) => ({tick, length, msTime, msLength}));
}

export function spanContains(spans: ReadonlyArray<TimeSpan>, tick: number): boolean {
	return spans.some((span) => tick >= span.tick && tick < span.tick + span.length);
}

export function chartDurationMs(groups: ReadonlyArray<NoteGroup>): number {
	return groups.reduce((end, group) => Math.max(end, group.msTime + group.msLength), 0);
}

export function buildPartChart(part: InstrumentPart, difficulty: BandDifficulty, track: ParsedTrack): PartChart {
	const isDrums = part === 'drums';
	const laneByType = isDrums ? DRUM_LANE_BY_NOTE_TYPE : FRET_LANE_BY_NOTE_TYPE;
	const starPower = toSpans(track.starPowerSections);
	const solos = toSpans(track.soloSections);

	const groups: Array<NoteGroup> = [];
	for (const events of track.noteEventGroups) {
		const lanes = new Set<number>();
		const cymbals = new Set<number>();
		let msLength = 0;
		let flags = 0;
		for (const event of events) {
			const lane = laneByType.get(event.type);
			if (lane === undefined) continue;
			lanes.add(lane);
			flags |= event.flags;
			if (isDrums && lane !== DrumLane.Kick && event.flags & noteFlags.cymbal) cymbals.add(lane);
			if (!isDrums) msLength = Math.max(msLength, event.msLength);
		}
		if (lanes.size === 0) continue;
		const {tick, msTime} = events[0];
		groups.push({
			tick,
			msTime,
			msLength,
			lanes: [...lanes].sort((a, b) => a - b),
			cymbals: [...cymbals].sort((a, b) => a - b),
			isHopo: !isDrums && (flags & noteFlags.hopo) !== 0,
			isTap: !isDrums && (flags & noteFlags.tap) !== 0,
			inStarPower: spanContains(starPower, tick),
			inSolo: spanContains(solos, tick),
		});
	}

	return {
		part,
		difficulty,
		derived: false,
		groups,
		starPower,
		solos,
		bigRockEnding: codaSpan(track.drumFreestyleSections),
		durationMs: chartDurationMs(groups),
	};
}
