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

export interface JudgeOptions {
	// Fret parts punish stray presses like an overstrum; drums ignore them, as in Rock Band.
	readonly overhitBreaksCombo?: boolean;
}

const GroupState = {Pending: 0, Hit: 1, Missed: 2} as const;

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
export class Judge {
	private readonly states: Uint8Array;
	private readonly pressOffsets = new Map<number, Map<number, number>>();
	private readonly heldLanes = new Set<number>();
	private sustains: Array<ActiveSustain> = [];
	private readonly difficultyMultiplier: number;
	private readonly overhitBreaksCombo: boolean;
	private firstOpenGroup = 0;
	private score = 0;
	private combo = 0;
	private maxCombo = 0;
	private misses = 0;
	private overhits = 0;
	private judgedGroups = 0;
	private readonly ratings: Record<HitRating, number> = {perfect: 0, good: 0, ok: 0};

	constructor(
		private readonly chart: PartChart,
		options: JudgeOptions = {},
	) {
		this.states = new Uint8Array(chart.groups.length);
		this.difficultyMultiplier = DIFFICULTY_SCORE_MULTIPLIER[chart.difficulty];
		this.overhitBreaksCombo = options.overhitBreaksCombo ?? chart.part !== 'drums';
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
		const events = this.settle(timeMs);
		this.heldLanes.add(lane);

		const groupIndex = this.findTarget(lane, timeMs);
		if (groupIndex === null) {
			this.overhits++;
			const comboBroken = this.overhitBreaksCombo && this.combo > 0;
			if (this.overhitBreaksCombo) this.combo = 0;
			events.push({kind: 'overhit', lane, timeMs, comboBroken});
			return events;
		}

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
		events.push({
			kind: 'hit',
			groupIndex,
			timeMs,
			offsetMs,
			rating,
			points,
			combo: this.combo,
			multiplier,
		});

		if (group.msLength > 0 && group.lanes.every((groupLane) => this.heldLanes.has(groupLane))) {
			const endMs = group.msTime + group.msLength;
			this.sustains.push({groupIndex, lanes: group.lanes, startMs: Math.max(group.msTime, timeMs), endMs, multiplier});
		}
		return events;
	}

	release(lane: number, timeMs: number): Array<JudgeEvent> {
		const events = this.settle(timeMs);
		this.heldLanes.delete(lane);
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

	// Call every frame with the current song time to settle notes nobody played.
	advance(nowMs: number): Array<JudgeEvent> {
		return this.settle(nowMs - MISS_SETTLE_MS);
	}

	// Settles everything left once the song is over.
	finish(): Array<JudgeEvent> {
		return this.settle(Number.POSITIVE_INFINITY);
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

	private settle(cutoffMs: number): Array<JudgeEvent> {
		const events: Array<JudgeEvent> = [];
		const still: Array<ActiveSustain> = [];
		for (const sustain of this.sustains) {
			if (sustain.endMs <= cutoffMs) events.push(this.endSustain(sustain, sustain.endMs, true));
			else still.push(sustain);
		}
		this.sustains = still;

		const {groups} = this.chart;
		while (this.firstOpenGroup < groups.length) {
			const index = this.firstOpenGroup;
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
