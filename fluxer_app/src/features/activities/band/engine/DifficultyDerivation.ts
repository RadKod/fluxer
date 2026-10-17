// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type BandDifficulty,
	chartDurationMs,
	DrumLane,
	FRET_LANE_COUNT,
	FretLane,
	type NoteGroup,
	type PartChart,
} from '@app/features/activities/band/engine/ChartModel';
import {BeatStrength, type TempoMap} from '@app/features/activities/band/engine/TempoMap';

export type DerivedDifficulty = Exclude<BandDifficulty, 'expert'>;

interface ThinningRule {
	// Kept notes stay at least this far apart (less GRID_TOLERANCE); notes on grids finer than the beat survive
	// only when that grid's step at the local tempo is this long.
	readonly minGapMs: number;
	// Kept note groups are capped at the larger of densityCeiling x Expert's count and floorNotesPerSecond x the
	// chart's length, so sparse ballads are not thinned as hard as dense songs.
	readonly densityCeiling: number;
	readonly floorNotesPerSecond: number;
	readonly maxChordSize: number;
}

interface FretRule extends ThinningRule {
	readonly laneCount: number;
	// Otherwise open notes become green, as on Harmonix Easy and Medium.
	readonly keepsOpenNotes: boolean;
}

interface DrumRule extends ThinningRule {
	// Kicks survive only on ticks at least this strong.
	readonly kickMaxStrength: BeatStrength;
}

// Measured on Harmonix/Neversoft charts (Snow, Nothing Else Matters, Misirlou): Easy keeps quarter notes on three
// lanes with no chords, Medium keeps eighths on four lanes, Hard keeps most sixteenths with smaller chords.
export const FRET_DERIVATION_RULES: Readonly<Record<DerivedDifficulty, FretRule>> = {
	hard: {
		laneCount: 5,
		keepsOpenNotes: true,
		maxChordSize: 2,
		minGapMs: 130,
		densityCeiling: 0.8,
		floorNotesPerSecond: 2.3,
	},
	medium: {
		laneCount: 4,
		keepsOpenNotes: false,
		maxChordSize: 2,
		minGapMs: 165,
		densityCeiling: 0.5,
		floorNotesPerSecond: 1.6,
	},
	easy: {
		laneCount: 3,
		keepsOpenNotes: false,
		maxChordSize: 1,
		minGapMs: 270,
		densityCeiling: 0.28,
		floorNotesPerSecond: 1.5,
	},
};

// Real drum charts thin less than guitar (Easy keeps about half) and mostly drop kicks.
export const DRUM_DERIVATION_RULES: Readonly<Record<DerivedDifficulty, DrumRule>> = {
	hard: {
		maxChordSize: 3,
		minGapMs: 130,
		densityCeiling: 0.87,
		floorNotesPerSecond: 1.6,
		kickMaxStrength: BeatStrength.OffGrid,
	},
	medium: {
		maxChordSize: 2,
		minGapMs: 200,
		densityCeiling: 0.62,
		floorNotesPerSecond: 1.1,
		kickMaxStrength: BeatStrength.Beat,
	},
	easy: {
		maxChordSize: 2,
		minGapMs: 270,
		densityCeiling: 0.5,
		floorNotesPerSecond: 0.9,
		kickMaxStrength: BeatStrength.Measure,
	},
};

// Slack on minGapMs so a tempo a hair faster than the rule assumes does not drop a whole grid level.
const GRID_TOLERANCE = 0.95;

interface Candidate {
	readonly expertIndex: number;
	readonly group: NoteGroup;
	readonly lanes: ReadonlyArray<number>;
	readonly strength: BeatStrength;
}

export function deriveDifficulty(expert: PartChart, target: DerivedDifficulty, tempoMap: TempoMap): PartChart {
	const isDrums = expert.part === 'drums';
	const rule: ThinningRule = isDrums ? DRUM_DERIVATION_RULES[target] : FRET_DERIVATION_RULES[target];

	const candidates: Array<Candidate> = [];
	expert.groups.forEach((group, expertIndex) => {
		const strength = tempoMap.beatStrengthAt(group.tick);
		const lanes = isDrums ? drumLanesFor(group, DRUM_DERIVATION_RULES[target], strength) : group.lanes;
		if (lanes.length > 0) candidates.push({expertIndex, group, lanes, strength});
	});

	const kept = thin(candidates, expert, rule, tempoMap);
	const groups = isDrums
		? kept.map((candidate) => drumGroup(candidate))
		: fretGroups(kept, FRET_DERIVATION_RULES[target], target, tempoMap);

	return {
		part: expert.part,
		difficulty: target,
		derived: true,
		groups,
		starPower: expert.starPower,
		solos: expert.solos,
		durationMs: chartDurationMs(groups),
	};
}

function thin(
	candidates: ReadonlyArray<Candidate>,
	expert: PartChart,
	rule: ThinningRule,
	tempoMap: TempoMap,
): Array<Candidate> {
	const {groups} = expert;
	const spanSeconds = groups.length > 1 ? (groups[groups.length - 1].msTime - groups[0].msTime) / 1000 : 0;
	const maxCount = Math.max(
		1,
		Math.round(Math.max(rule.densityCeiling * groups.length, rule.floorNotesPerSecond * spanSeconds)),
	);
	const keptTimes: Array<number> = [];
	const kept: Array<Candidate> = [];

	const fitsGrid = (candidate: Candidate, index: number) => {
		if (candidate.strength <= BeatStrength.Beat) return true;
		const stepMs =
			candidate.strength === BeatStrength.OffGrid
				? candidate.group.msTime - (candidates[index - 1]?.group.msTime ?? Number.NEGATIVE_INFINITY)
				: tempoMap.gridStepMsAt(candidate.group.tick, candidate.strength);
		return stepMs >= rule.minGapMs * GRID_TOLERANCE;
	};

	for (let level: number = BeatStrength.Measure; level <= BeatStrength.OffGrid; level++) {
		if (kept.length >= maxCount) break;
		const eligible: Array<Candidate> = [];
		const tentativeTimes = [...keptTimes];
		candidates.forEach((candidate, index) => {
			if (candidate.strength !== level || !fitsGrid(candidate, index)) return;
			if (!hasRoom(tentativeTimes, candidate.group.msTime, rule.minGapMs * GRID_TOLERANCE)) return;
			insertSorted(tentativeTimes, candidate.group.msTime);
			eligible.push(candidate);
		});
		const remaining = maxCount - kept.length;
		const chosen = eligible.length <= remaining ? eligible : evenlySpaced(eligible, remaining);
		for (const candidate of chosen) {
			kept.push(candidate);
			insertSorted(keptTimes, candidate.group.msTime);
		}
	}

	// A star power phrase with no notes could never be earned; keep its strongest note.
	for (const phrase of expert.starPower) {
		const inPhrase = (candidate: Candidate) =>
			candidate.group.tick >= phrase.tick && candidate.group.tick < phrase.tick + phrase.length;
		if (kept.some(inPhrase)) continue;
		const strongest = candidates.filter(inPhrase).sort((a, b) => a.strength - b.strength)[0];
		if (strongest) kept.push(strongest);
	}

	return kept.sort((a, b) => a.expertIndex - b.expertIndex);
}

function hasRoom(sortedTimes: ReadonlyArray<number>, msTime: number, minGapMs: number): boolean {
	const index = lowerBound(sortedTimes, msTime);
	const before = sortedTimes[index - 1];
	const after = sortedTimes[index];
	return (before === undefined || msTime - before >= minGapMs) && (after === undefined || after - msTime >= minGapMs);
}

function insertSorted(sortedTimes: Array<number>, msTime: number) {
	sortedTimes.splice(lowerBound(sortedTimes, msTime), 0, msTime);
}

function lowerBound(sortedTimes: ReadonlyArray<number>, value: number): number {
	let low = 0;
	let high = sortedTimes.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (sortedTimes[middle] < value) low = middle + 1;
		else high = middle;
	}
	return low;
}

function evenlySpaced<T>(items: ReadonlyArray<T>, count: number): Array<T> {
	if (count <= 0) return [];
	return Array.from({length: count}, (_, i) => items[Math.floor(((i + 0.5) * items.length) / count)]);
}

// Keeps the outer notes of a chord, which carry its shape, and fills inward when more fit.
function trimChord(lanes: ReadonlyArray<number>, maxSize: number): Array<number> {
	if (lanes.length <= maxSize) return [...lanes];
	if (maxSize === 1) return [lanes[0]];
	return Array.from({length: maxSize}, (_, i) => lanes[Math.round((i * (lanes.length - 1)) / (maxSize - 1))]);
}

function drumLanesFor(group: NoteGroup, rule: DrumRule, strength: BeatStrength): Array<number> {
	const priority = (lane: number) => {
		if (lane === DrumLane.Red) return 0;
		if (group.cymbals.includes(lane)) return 1;
		if (lane === DrumLane.Kick) return 2;
		return 3;
	};
	return group.lanes
		.filter((lane) => lane !== DrumLane.Kick || strength <= rule.kickMaxStrength)
		.sort((a, b) => priority(a) - priority(b) || a - b)
		.slice(0, rule.maxChordSize)
		.sort((a, b) => a - b);
}

function drumGroup({group, lanes}: Candidate): NoteGroup {
	return {...group, lanes, cymbals: group.cymbals.filter((lane) => lanes.includes(lane))};
}

// Maps five fret lanes onto `laneCount`, one measure at a time. A measure whose span fits is shifted (by the
// amount closest to the previous measure's shift, so repeated riffs stay put); a wider one is squeezed. Both keep
// the direction of every move, though squeezing can turn a small step into a repeat.
function fretGroups(
	kept: ReadonlyArray<Candidate>,
	rule: FretRule,
	target: DerivedDifficulty,
	tempoMap: TempoMap,
): Array<NoteGroup> {
	const measures = new Map<number, Array<Candidate>>();
	for (const candidate of kept) {
		const measure = tempoMap.measureIndexAt(candidate.group.tick);
		const bucket = measures.get(measure);
		if (bucket) bucket.push(candidate);
		else measures.set(measure, [candidate]);
	}

	const maxLane = rule.laneCount - 1;
	const mappedLanes = new Map<Candidate, Array<number>>();
	let previousShift = 0;
	for (const bucket of measures.values()) {
		const fretted = bucket.flatMap((candidate) => candidate.lanes.filter((lane) => lane !== FretLane.Open));
		const low = Math.min(...fretted);
		const high = Math.max(...fretted);
		let mapLane: (lane: number) => number;
		if (fretted.length === 0 || rule.laneCount >= FRET_LANE_COUNT) {
			mapLane = (lane) => lane;
		} else if (high - low <= maxLane) {
			const shift = Math.min(Math.max(previousShift, high - maxLane, 0), low);
			previousShift = shift;
			mapLane = (lane) => lane - shift;
		} else {
			mapLane = (lane) => Math.round(((lane - low) * maxLane) / (high - low));
		}
		for (const candidate of bucket) {
			const lanes = candidate.lanes.map((lane) => {
				if (lane !== FretLane.Open) return mapLane(lane);
				return rule.keepsOpenNotes ? lane : FretLane.Green;
			});
			mappedLanes.set(
				candidate,
				trimChord(
					[...new Set(lanes)].sort((a, b) => a - b),
					rule.maxChordSize,
				),
			);
		}
	}

	return kept.map((candidate, index) => {
		const lanes = mappedLanes.get(candidate)!;
		const previous = kept[index - 1];
		const followsDirectly = previous !== undefined && previous.expertIndex === candidate.expertIndex - 1;
		const changesLanes = previous !== undefined && !sameLanes(mappedLanes.get(previous)!, lanes);
		return {
			...candidate.group,
			lanes,
			isHopo: target !== 'easy' && candidate.group.isHopo && followsDirectly && changesLanes,
			isTap: target !== 'easy' && candidate.group.isTap,
		};
	});
}

function sameLanes(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
	return a.length === b.length && a.every((lane, i) => lane === b[i]);
}
