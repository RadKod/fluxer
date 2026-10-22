// SPDX-License-Identifier: AGPL-3.0-or-later

// Rock Band 4 style scoring for freestyle solos: nothing can be missed, and a press scores when it follows the cue
// under it. A cue pays about as many presses as the chart has notes there, so following the cues is worth about as
// much as playing the charted solo, and mashing faster than the solo earns nothing more.

import type {BandDifficulty} from '@app/features/activities/band/engine/ChartModel';
import {
	type SoloCue,
	type SoloCueRegion,
	type SoloSection,
	soloCueAt,
} from '@app/features/activities/band/engine/FreestyleSolo';
import {
	DIFFICULTY_SCORE_MULTIPLIER,
	NOTE_POINTS,
	SUSTAIN_POINTS_PER_SECOND,
} from '@app/features/activities/band/engine/Judge';

export const FREESTYLE_SCORING = {
	// A strum cue counts presses that keep a run going: each one this soon after the last.
	strumGapMs: 200,
	// A tap cue counts presses that alternate keys this fast.
	tapGapMs: 260,
	// Presses paid per charted note under a cue, plus a few for the cue's first notes.
	pressesPerNote: 1.5,
	slackPresses: 2,
} as const;

// The yellow lane belongs to both, so a player can move between the bands through it.
export const CUE_REGION_LANES: Readonly<Record<SoloCueRegion, ReadonlyArray<number>>> = {
	high: [2, 3, 4],
	low: [0, 1, 2],
};

export interface FreestylePressRef {
	readonly lane: number;
	readonly ms: number;
}

// The first press under a cue always follows its style: a run has to start somewhere.
export function followsCue(cue: SoloCue, lane: number, previous: FreestylePressRef | null, ms: number): boolean {
	if (cue.region && !CUE_REGION_LANES[cue.region].includes(lane)) return false;
	const opens = previous === null || previous.ms < cue.startMs;
	switch (cue.style) {
		case 'free':
		case 'sustain':
			return true;
		case 'strum':
			return opens || ms - (previous?.ms ?? ms) <= FREESTYLE_SCORING.strumGapMs;
		case 'tap':
			return opens || (previous !== null && ms - previous.ms <= FREESTYLE_SCORING.tapGapMs && lane !== previous.lane);
	}
}

export function cuePressBudget(cue: SoloCue): number {
	return Math.ceil(cue.notes * FREESTYLE_SCORING.pressesPerNote) + FREESTYLE_SCORING.slackPresses;
}

export interface FreestylePress {
	// The press follows the cue under it.
	readonly following: boolean;
	// It also scored and adds to the streak; false past the cue's budget.
	readonly counted: boolean;
	// Before star power doubles it.
	readonly points: number;
}

const NO_PRESS: FreestylePress = {following: false, counted: false, points: 0};

export function regionHeld(cue: SoloCue, heldLanes: Iterable<number>): boolean {
	const region = cue.region ? CUE_REGION_LANES[cue.region] : null;
	for (const lane of heldLanes) if (!region || region.includes(lane)) return true;
	return false;
}

// One player's freestyle scoring across the song's solo sections. Times are song ms.
export class FreestyleScorer {
	private previous: FreestylePressRef | null = null;
	private readonly counted = new Map<SoloCue, number>();
	private readonly difficultyMultiplier: number;

	constructor(difficulty: BandDifficulty) {
		this.difficultyMultiplier = DIFFICULTY_SCORE_MULTIPLIER[difficulty];
	}

	press(section: SoloSection, lane: number, ms: number, multiplier: number): FreestylePress {
		const cue = soloCueAt(section, ms);
		const previous = this.previous;
		this.previous = {lane, ms};
		if (!cue || !followsCue(cue, lane, previous, ms)) return NO_PRESS;
		const pressed = this.counted.get(cue) ?? 0;
		if (pressed >= cuePressBudget(cue)) return {following: true, counted: false, points: 0};
		this.counted.set(cue, pressed + 1);
		return {following: true, counted: true, points: NOTE_POINTS * multiplier * this.difficultyMultiplier};
	}

	// Points for holding a note through the sustain cues between fromMs and toMs, with `heldLanes` down all along
	// (called every frame, so the span is one frame).
	sustainPoints(
		section: SoloSection,
		heldLanes: ReadonlySet<number>,
		fromMs: number,
		toMs: number,
		multiplier: number,
	): number {
		if (heldLanes.size === 0 || toMs <= fromMs) return 0;
		let heldMs = 0;
		for (const cue of section.cues) {
			if (cue.style !== 'sustain' || !regionHeld(cue, heldLanes)) continue;
			heldMs += Math.max(0, Math.min(toMs, cue.endMs) - Math.max(fromMs, cue.startMs));
		}
		return ((SUSTAIN_POINTS_PER_SECOND * heldMs) / 1000) * multiplier * this.difficultyMultiplier;
	}
}
