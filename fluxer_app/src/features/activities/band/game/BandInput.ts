// SPDX-License-Identifier: AGPL-3.0-or-later

import {DrumLane, FretLane, type InstrumentPart} from '@app/features/activities/band/engine/ChartModel';
import {
	type AudioClockAnchor,
	performanceToContextTime,
	songTimeMs,
} from '@app/features/activities/band/engine/SessionClock';

// KeyboardEvent.code values, so the map follows key positions and works on Turkish Q and F layouts alike.
export interface BandKeyMap {
	readonly frets: ReadonlyArray<string>;
	readonly drumPads: ReadonlyArray<string>;
	readonly kick: ReadonlyArray<string>;
	readonly starPower: ReadonlyArray<string>;
}

export const DEFAULT_BAND_KEY_MAP: BandKeyMap = {
	frets: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG'],
	drumPads: ['KeyH', 'KeyJ', 'KeyK', 'KeyL'],
	kick: ['Space'],
	starPower: ['Enter', 'ShiftRight'],
};

export type BandInputAction =
	| {readonly kind: 'lane'; readonly lane: number}
	| {readonly kind: 'starPower'}
	| {readonly kind: 'none'};

const NO_ACTION: BandInputAction = {kind: 'none'};
const FRET_LANES = [FretLane.Green, FretLane.Red, FretLane.Yellow, FretLane.Blue, FretLane.Orange];
const DRUM_PAD_LANES = [DrumLane.Red, DrumLane.Yellow, DrumLane.Blue, DrumLane.Green];

export function actionForKey(map: BandKeyMap, part: InstrumentPart, code: string): BandInputAction {
	if (map.starPower.includes(code)) return {kind: 'starPower'};
	if (part === 'drums') {
		if (map.kick.includes(code)) return {kind: 'lane', lane: DrumLane.Kick};
		const pad = map.drumPads.indexOf(code);
		return pad >= 0 ? {kind: 'lane', lane: DRUM_PAD_LANES[pad]} : NO_ACTION;
	}
	const fret = map.frets.indexOf(code);
	return fret >= 0 ? {kind: 'lane', lane: FRET_LANES[fret]} : NO_ACTION;
}

// The judge's clock for an input event: when the press reached the page, mapped onto the audio the player was
// hearing at that moment, minus their calibrated latency.
export function inputSongTimeMs(
	eventTimeStamp: number,
	anchor: AudioClockAnchor,
	songZeroContextTime: number,
	inputLatencyMs: number,
): number {
	return songTimeMs(performanceToContextTime(eventTimeStamp, anchor), songZeroContextTime, inputLatencyMs);
}

export interface LaneInput {
	readonly kind: 'press' | 'release';
	readonly lane: number;
	readonly timeStamp: number;
}

export interface BandKeyboardHandlers {
	readonly onLane: (input: LaneInput) => void;
	readonly onStarPower: (timeStamp: number) => void;
}

// Turns key events into lane presses and releases. Auto-repeat and modifier chords are ignored, and a key held while
// the window loses focus is released so a sustain does not stay held forever.
export class BandKeyboard {
	private readonly held = new Map<string, number>();

	constructor(
		private readonly map: BandKeyMap,
		private readonly part: InstrumentPart,
		private readonly handlers: BandKeyboardHandlers,
	) {}

	// Returns true when the key belongs to the game, so the caller can preventDefault.
	keyDown(event: Pick<KeyboardEvent, 'code' | 'repeat' | 'timeStamp' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
		if (event.ctrlKey || event.metaKey || event.altKey) return false;
		const action = actionForKey(this.map, this.part, event.code);
		if (action.kind === 'none') return false;
		if (event.repeat || this.held.has(event.code)) return true;
		if (action.kind === 'starPower') {
			this.held.set(event.code, -1);
			this.handlers.onStarPower(event.timeStamp);
			return true;
		}
		this.held.set(event.code, action.lane);
		this.handlers.onLane({kind: 'press', lane: action.lane, timeStamp: event.timeStamp});
		return true;
	}

	keyUp(event: Pick<KeyboardEvent, 'code' | 'timeStamp'>): boolean {
		const lane = this.held.get(event.code);
		if (lane === undefined) return false;
		this.held.delete(event.code);
		if (lane >= 0 && !this.isLaneHeldElsewhere(lane)) {
			this.handlers.onLane({kind: 'release', lane, timeStamp: event.timeStamp});
		}
		return true;
	}

	releaseAll(timeStamp: number): void {
		const lanes = new Set([...this.held.values()].filter((lane) => lane >= 0));
		this.held.clear();
		for (const lane of lanes) this.handlers.onLane({kind: 'release', lane, timeStamp});
	}

	private isLaneHeldElsewhere(lane: number): boolean {
		for (const held of this.held.values()) if (held === lane) return true;
		return false;
	}
}
