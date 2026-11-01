// SPDX-License-Identifier: AGPL-3.0-or-later

import type {JudgeEvent} from '@app/features/activities/band/engine/Judge';
import {type FeedbackKind, laneNeighbours, type SeatTrack} from '@app/features/activities/band/game/PlayController';

// What the timing readout keeps: the last few presses of my highway and how the frames are coming. Cheap enough to
// run on every song; the readout only shows it when asked for.
const PRESS_LIMIT = 6;
// The nearest note is looked for this far either side of a press.
const NEAREST_NOTE_MS = 1_000;
const FRAME_SMOOTHING = 0.05;
// A longer gap is a stall or a hidden tab, not frame time.
const MAX_FRAME_SAMPLE_MS = 100;

// 'stray' is a press that played no note and was near none to call early or late; null while undecided (a chord
// waiting out its slop) or for a press the judge never saw (free play, a freestyle solo).
export type PressVerdict = FeedbackKind | 'stray' | null;

export interface PressRecord {
	readonly lane: number;
	// KeyboardEvent.timeStamp as delivered, and performance.now() when it was handled.
	readonly eventTimeStamp: number;
	readonly handledAt: number;
	// Song ms the judge got: the trusted stamp on the audio clock, minus the input latency.
	readonly judgeMs: number;
	readonly nearestNoteMs: number | null;
	verdict: PressVerdict;
}

export class BandTimingProbe {
	presses: ReadonlyArray<PressRecord> = [];
	// Smoothed time between animation frames, and the refresh interval the frame pacer settled on.
	frameMs = 0;
	refreshIntervalMs = 0;
	private lastFrame: number | null = null;

	recordFrame(frameTimestamp: number, refreshIntervalMs: number): void {
		this.refreshIntervalMs = refreshIntervalMs;
		const last = this.lastFrame;
		this.lastFrame = frameTimestamp;
		if (last === null) return;
		const sample = frameTimestamp - last;
		if (sample <= 0 || sample > MAX_FRAME_SAMPLE_MS) return;
		this.frameMs = this.frameMs === 0 ? sample : this.frameMs + (sample - this.frameMs) * FRAME_SMOOTHING;
	}

	recordPress(
		track: SeatTrack | null,
		press: Omit<PressRecord, 'nearestNoteMs' | 'verdict'>,
		events: ReadonlyArray<JudgeEvent>,
	): void {
		const record: PressRecord = {
			...press,
			nearestNoteMs: track ? nearestNoteMs(track, press.lane, press.judgeMs) : null,
			verdict: track ? verdictOf(track, press.judgeMs, events) : null,
		};
		this.presses = [record, ...this.presses].slice(0, PRESS_LIMIT);
	}

	// A fret note counts a chord's slop after its last key; its judgement carries that key's press time.
	observe(feedback: SeatTrack['feedback']): void {
		if (!feedback) return;
		for (const press of this.presses) {
			if (press.verdict === null && press.judgeMs === feedback.atMs) press.verdict = feedback.kind;
		}
	}
}

function nearestNoteMs(track: SeatTrack, lane: number, songMs: number): number | null {
	const {groups} = track.chart;
	const {before, after} = laneNeighbours(groups, lane, songMs, NEAREST_NOTE_MS);
	if (before === null) return after === null ? null : groups[after].msTime;
	if (after === null) return groups[before].msTime;
	const beforeMs = groups[before].msTime;
	const afterMs = groups[after].msTime;
	return afterMs - songMs < songMs - beforeMs ? afterMs : beforeMs;
}

function verdictOf(track: SeatTrack, songMs: number, events: ReadonlyArray<JudgeEvent>): PressVerdict {
	const {feedback} = track;
	if (feedback && feedback.atMs === songMs) return feedback.kind;
	return events.some((event) => event.kind === 'overhit' && event.timeMs === songMs) ? 'stray' : null;
}
