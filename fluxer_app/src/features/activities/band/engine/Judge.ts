// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandDifficulty, PartChart} from '@app/features/activities/band/engine/ChartModel';

// Half-widths around the note time; anything further than `ok` cannot hit the note.
export const HIT_WINDOWS_MS = {perfect: 35, good: 70, ok: 100} as const;
export type HitRating = keyof typeof HIT_WINDOWS_MS;

export const RATING_SCORE_FACTOR: Readonly<Record<HitRating, number>> = {perfect: 1, good: 0.8, ok: 0.5};
export const DIFFICULTY_SCORE_MULTIPLIER: Readonly<Record<BandDifficulty, number>> = {
	easy: 1,
	medium: 1.25,
	hard: 1.5,
	expert: 2,
};

// Points per lane of a hit group and per lane-second of a held sustain, before any multiplier.
export const NOTE_POINTS = 50;
export const SUSTAIN_POINTS_PER_SECOND = 50;
export const HITS_PER_MULTIPLIER_STEP = 10;
export const MAX_MULTIPLIER = 4;

// Letting go of a sustain this close to its end still counts as holding it through.
export const SUSTAIN_RELEASE_TOLERANCE_MS = HIT_WINDOWS_MS.ok;

// advance() leaves misses open this long past the window, so input delivered a frame late is still judged.
export const MISS_SETTLE_MS = 50;

// One 60 Hz frame. A fret note is only hit when no stray key is down with it: the keys of a chord seldom land on
// the same frame, and a finger leaving a stray key lifts a frame late, so a completed note waits this long before
// it counts.
export const CHORD_SLOP_MS = 17;

export type JudgeEvent =
	| {
			readonly kind: 'hit';
			readonly groupIndex: number;
			readonly timeMs: number;
			// Press time minus note time of the worst-timed lane; negative is early.
			readonly offsetMs: number;
			readonly rating: HitRating;
			readonly points: number;
			readonly combo: number;
			readonly multiplier: number;
	  }
	| {readonly kind: 'miss'; readonly groupIndex: number; readonly timeMs: number}
	// A press with no note to play, or a fret note played with a stray key down (then `lane` is that key). It breaks
	// the combo but uses up no note: a rejected note stays open while its window lasts.
	| {readonly kind: 'overhit'; readonly lane: number; readonly timeMs: number; readonly comboBroken: boolean}
	| {
			readonly kind: 'sustain';
			readonly groupIndex: number;
			readonly timeMs: number;
			readonly heldMs: number;
			readonly points: number;
			readonly complete: boolean;
	  };

export interface JudgeSnapshot {
	readonly score: number;
	readonly combo: number;
	readonly maxCombo: number;
	// Multiplier the next hit will score at.
	readonly multiplier: number;
	readonly ratings: Readonly<Record<HitRating, number>>;
	readonly misses: number;
	readonly overhits: number;
	readonly judgedGroups: number;
	readonly totalGroups: number;
}

// Settling: every lane is pressed, waiting out CHORD_SLOP_MS for a stray key.
const GroupState = {Pending: 0, Hit: 1, Missed: 2, Settling: 3} as const;

interface SettlingNote {
	readonly groupIndex: number;
	readonly completedMs: number;
	readonly offsetMs: number;
	// Stray keys down with the note; it counts only if all are let go within the slop.
	readonly strays: Set<number>;
}

interface ActiveSustain {
	readonly groupIndex: number;
	readonly lanes: ReadonlyArray<number>;
	readonly startMs: number;
	readonly endMs: number;
	readonly multiplier: number;
}

export function multiplierForStreak(streak: number): number {
	return Math.min(MAX_MULTIPLIER, 1 + Math.floor(streak / HITS_PER_MULTIPLIER_STEP));
}

export function ratingForOffset(offsetMs: number): HitRating | null {
	const distance = Math.abs(offsetMs);
	if (distance <= HIT_WINDOWS_MS.perfect) return 'perfect';
	if (distance <= HIT_WINDOWS_MS.good) return 'good';
	if (distance <= HIT_WINDOWS_MS.ok) return 'ok';
	return null;
}

// Judges one player's input against their own chart. Times are song milliseconds (audio clock minus calibrated
// latency); press and release times must not go backwards. Every call returns the events it produced.
//
// A press with no note on its lane in the window is an overhit and breaks the combo, on drums too. On fret parts a
// note also needs exactly its own keys: a key pressed for no note and still down when the note completes (or pressed
// within CHORD_SLOP_MS after) rejects it, so mashing every key never plays a chord. A key still down from the note
// before is not a stray; it was spent on that note and cannot help play this one.
export class Judge {
	private readonly states: Uint8Array;
	private readonly pressOffsets = new Map<number, Map<number, number>>();
	private readonly heldLanes = new Set<number>();
	// Held lanes whose press found no note.
	private readonly strayLanes = new Set<number>();
	private settling: Array<SettlingNote> = [];
	private sustains: Array<ActiveSustain> = [];
	private readonly difficultyMultiplier: number;
	private readonly needsExactLanes: boolean;
	private firstOpenGroup = 0;
	private score = 0;
	private combo = 0;
	private maxCombo = 0;
	private misses = 0;
	private overhits = 0;
	private judgedGroups = 0;
	private readonly ratings: Record<HitRating, number> = {perfect: 0, good: 0, ok: 0};

	constructor(private readonly chart: PartChart) {
		this.states = new Uint8Array(chart.groups.length);
		this.difficultyMultiplier = DIFFICULTY_SCORE_MULTIPLIER[chart.difficulty];
		// Drum pads are struck, not held; a pad still down says nothing.
		this.needsExactLanes = chart.part !== 'drums';
	}

	get snapshot(): JudgeSnapshot {
		return {
			score: this.score,
			combo: this.combo,
			maxCombo: this.maxCombo,
			multiplier: multiplierForStreak(this.combo),
			ratings: {...this.ratings},
			misses: this.misses,
			overhits: this.overhits,
			judgedGroups: this.judgedGroups,
			totalGroups: this.chart.groups.length,
		};
	}

	press(lane: number, timeMs: number): Array<JudgeEvent> {
		const events = this.settle(timeMs, timeMs);
		this.heldLanes.add(lane);

		const groupIndex = this.findTarget(lane, timeMs);
		if (groupIndex === null) {
			if (!this.needsExactLanes) {
				events.push(this.overhit(lane, timeMs));
				return events;
			}
			this.strayLanes.add(lane);
			// A note waiting out its slop takes the blame instead; letting go in time forgives both.
			if (this.settling.length > 0) for (const note of this.settling) note.strays.add(lane);
			else events.push(this.overhit(lane, timeMs));
			return events;
		}
		this.strayLanes.delete(lane);

		const group = this.chart.groups[groupIndex];
		let offsets = this.pressOffsets.get(groupIndex);
		if (!offsets) {
			offsets = new Map();
			this.pressOffsets.set(groupIndex, offsets);
		}
		offsets.set(lane, timeMs - group.msTime);
		if (offsets.size < group.lanes.length) return events;

		this.pressOffsets.delete(groupIndex);
		const offsetMs = [...offsets.values()].reduce((worst, offset) =>
			Math.abs(offset) > Math.abs(worst) ? offset : worst,
		);
		const note: SettlingNote = {groupIndex, completedMs: timeMs, offsetMs, strays: new Set(this.strayLanes)};
		if (!this.needsExactLanes) {
			events.push(this.hit(note));
			return events;
		}
		this.states[groupIndex] = GroupState.Settling;
		this.settling.push(note);
		return events;
	}

	release(lane: number, timeMs: number): Array<JudgeEvent> {
		const events = this.settle(timeMs, timeMs);
		this.heldLanes.delete(lane);
		this.strayLanes.delete(lane);
		for (const note of this.settling) note.strays.delete(lane);
		const still: Array<ActiveSustain> = [];
		for (const sustain of this.sustains) {
			if (!sustain.lanes.includes(lane)) {
				still.push(sustain);
				continue;
			}
			const complete = timeMs >= sustain.endMs - SUSTAIN_RELEASE_TOLERANCE_MS;
			events.push(this.endSustain(sustain, complete ? sustain.endMs : timeMs, complete));
		}
		this.sustains = still;
		return events;
	}

	// A freestyle solo press that followed its cue: the streak grows as if a note was hit, so the multiplier earned in
	// the solo carries on into the notes after it. Returns the new streak.
	addStreak(): number {
		this.combo++;
		this.maxCombo = Math.max(this.maxCombo, this.combo);
		return this.combo;
	}

	// Call every frame with the current song time to settle notes nobody played.
	advance(nowMs: number): Array<JudgeEvent> {
		return this.settle(nowMs - MISS_SETTLE_MS, nowMs);
	}

	// Settles everything left once the song is over.
	finish(): Array<JudgeEvent> {
		return this.settle(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	}

	private findTarget(lane: number, timeMs: number): number | null {
		const {groups} = this.chart;
		for (let i = this.firstOpenGroup; i < groups.length; i++) {
			const group = groups[i];
			if (group.msTime - HIT_WINDOWS_MS.ok > timeMs) break;
			if (this.states[i] !== GroupState.Pending || !group.lanes.includes(lane)) continue;
			if (this.pressOffsets.get(i)?.has(lane)) continue;
			if (Math.abs(timeMs - group.msTime) <= HIT_WINDOWS_MS.ok) return i;
		}
		return null;
	}

	// Decides settling notes whose slop ended before `nowMs`, then ends sustains and misses notes up to `cutoffMs`.
	private settle(cutoffMs: number, nowMs: number): Array<JudgeEvent> {
		const events: Array<JudgeEvent> = [];
		const waiting: Array<SettlingNote> = [];
		for (const note of this.settling) {
			if (note.completedMs + CHORD_SLOP_MS >= nowMs) waiting.push(note);
			else if (note.strays.size === 0) events.push(this.hit(note));
			else events.push(this.reject(note));
		}
		this.settling = waiting;

		const still: Array<ActiveSustain> = [];
		for (const sustain of this.sustains) {
			if (sustain.endMs <= cutoffMs) events.push(this.endSustain(sustain, sustain.endMs, true));
			else still.push(sustain);
		}
		this.sustains = still;

		const {groups} = this.chart;
		while (this.firstOpenGroup < groups.length) {
			const index = this.firstOpenGroup;
			if (this.states[index] === GroupState.Settling) break;
			if (this.states[index] === GroupState.Pending) {
				const group = groups[index];
				if (group.msTime + HIT_WINDOWS_MS.ok >= cutoffMs) break;
				this.states[index] = GroupState.Missed;
				this.pressOffsets.delete(index);
				this.judgedGroups++;
				this.misses++;
				this.combo = 0;
				events.push({kind: 'miss', groupIndex: index, timeMs: group.msTime});
			}
			this.firstOpenGroup++;
		}
		return events;
	}

	private hit({groupIndex, completedMs, offsetMs}: SettlingNote): JudgeEvent {
		const group = this.chart.groups[groupIndex];
		const rating = ratingForOffset(offsetMs) ?? 'ok';
		const multiplier = multiplierForStreak(this.combo);
		const points = Math.round(
			NOTE_POINTS * group.lanes.length * RATING_SCORE_FACTOR[rating] * multiplier * this.difficultyMultiplier,
		);
		this.states[groupIndex] = GroupState.Hit;
		this.judgedGroups++;
		this.ratings[rating]++;
		this.score += points;
		this.combo++;
		this.maxCombo = Math.max(this.maxCombo, this.combo);
		if (group.msLength > 0 && group.lanes.every((groupLane) => this.heldLanes.has(groupLane))) {
			const endMs = group.msTime + group.msLength;
			this.sustains.push({
				groupIndex,
				lanes: group.lanes,
				startMs: Math.max(group.msTime, completedMs),
				endMs,
				multiplier,
			});
		}
		return {kind: 'hit', groupIndex, timeMs: completedMs, offsetMs, rating, points, combo: this.combo, multiplier};
	}

	// The note goes back to open, so the right keys can still play it inside its window.
	private reject(note: SettlingNote): JudgeEvent {
		this.states[note.groupIndex] = GroupState.Pending;
		return this.overhit(Math.min(...note.strays), note.completedMs);
	}

	private overhit(lane: number, timeMs: number): JudgeEvent {
		this.overhits++;
		const comboBroken = this.combo > 0;
		this.combo = 0;
		return {kind: 'overhit', lane, timeMs, comboBroken};
	}

	private endSustain(sustain: ActiveSustain, endMs: number, complete: boolean): JudgeEvent {
		const heldMs = Math.max(0, endMs - sustain.startMs);
		const points = Math.round(
			((SUSTAIN_POINTS_PER_SECOND * sustain.lanes.length * heldMs) / 1000) *
				sustain.multiplier *
				this.difficultyMultiplier,
		);
		this.score += points;
		return {kind: 'sustain', groupIndex: sustain.groupIndex, timeMs: endMs, heldMs, points, complete};
	}
}
