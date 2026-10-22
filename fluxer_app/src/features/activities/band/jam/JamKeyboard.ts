// SPDX-License-Identifier: AGPL-3.0-or-later

// Jam mode's keys on top of the band key map: the five lane keys play the lanes, the kick key (Space by default) bends
// a melodic note or plays the kick, Z and X move the octave. Holding a lane sustains; two neighbouring lanes struck
// together on the lead guitar make a pinch harmonic of the lower note. Shift picks a drum lane's alternate piece and
// bends a step and a half instead of a whole step.

import type {BandJamInstrument} from '@app/features/activities/band/BandProtocol';
import type {BandKeyMap} from '@app/features/activities/band/game/BandInput';
import type {JamNoteOptions} from '@app/features/activities/band/jam/JamInstruments';
import type {JamAction} from '@app/features/activities/band/jam/JamPlayer';
import {JAM_LANE_COUNT} from '@app/features/activities/band/jam/JamScales';
import type {BendSemitones} from '@app/features/activities/band/jam/JamTechniques';

// Two neighbouring lane keys going down within this make one pinch. Fast enough that a deliberate two-note run is not
// mistaken for it, slow enough for two fingers that mean to land together.
export const JAM_PINCH_WINDOW_MS = 35;
export const JAM_OCTAVE_DOWN_CODE = 'KeyZ';
export const JAM_OCTAVE_UP_CODE = 'KeyX';
export const JAM_BEND_SEMITONES: BendSemitones = 2;
export const JAM_WIDE_BEND_SEMITONES: BendSemitones = 3;

export type JamKeyAction =
	| {readonly kind: 'lane'; readonly lane: number; readonly alternate: boolean}
	| {readonly kind: 'bend'; readonly semitones: BendSemitones}
	| {readonly kind: 'octave'; readonly delta: -1 | 1}
	| {readonly kind: 'none'};

const NO_ACTION: JamKeyAction = {kind: 'none'};

// Lanes come from the map's fret keys, so a player who moved them in the game finds them in the same place here.
export function jamActionForKey(
	map: BandKeyMap,
	instrument: BandJamInstrument,
	code: string,
	shift: boolean,
): JamKeyAction {
	const lane = map.frets.indexOf(code);
	if (lane >= 0 && lane < JAM_LANE_COUNT) return {kind: 'lane', lane, alternate: shift};
	if (instrument === 'drums') return map.kick.includes(code) ? {kind: 'lane', lane: 0, alternate: false} : NO_ACTION;
	if (map.kick.includes(code)) return {kind: 'bend', semitones: shift ? JAM_WIDE_BEND_SEMITONES : JAM_BEND_SEMITONES};
	if (code === JAM_OCTAVE_DOWN_CODE) return {kind: 'octave', delta: -1};
	if (code === JAM_OCTAVE_UP_CODE) return {kind: 'octave', delta: 1};
	return NO_ACTION;
}

export interface JamLanePress {
	readonly lane: number;
	readonly at: number;
}

// The lane whose note a pinch plays when `lane` goes down at `at` after `previous`, or null when it is no pinch.
export function pinchLane(previous: JamLanePress | null, lane: number, at: number): number | null {
	if (!previous || Math.abs(previous.lane - lane) !== 1) return null;
	const gap = at - previous.at;
	return gap >= 0 && gap <= JAM_PINCH_WINDOW_MS ? Math.min(previous.lane, lane) : null;
}

export interface JamLaneSound {
	readonly note: number;
	readonly options: JamNoteOptions;
}

export interface JamKeyboardTarget {
	// Null while I have no instrument: keys then do nothing.
	instrument(): BandJamInstrument | null;
	laneSound(lane: number, alternate: boolean, pinch: boolean): JamLaneSound | null;
	play(action: JamAction, timeStamp: number): void;
	shiftOctave(delta: -1 | 1): void;
	showLane(lane: number, down: boolean, pinch: boolean): void;
	showBend(semitones: number): void;
}

export type JamKeyEvent = Pick<
	KeyboardEvent,
	'code' | 'repeat' | 'timeStamp' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'
>;

interface HeldLane {
	readonly lane: number;
	// What its note off releases; null for drums, whose hits ring out on their own.
	readonly note: number | null;
	readonly pinch: boolean;
}

export class JamKeyboard {
	private readonly held = new Map<string, HeldLane>();
	private lastPress: (JamLanePress & {readonly code: string}) | null = null;
	private bendCode: string | null = null;

	constructor(
		private readonly map: BandKeyMap,
		private readonly target: JamKeyboardTarget,
	) {}

	// True when the key belongs to jam mode, so the caller can preventDefault (Space must not scroll or click).
	keyDown(event: JamKeyEvent): boolean {
		if (event.ctrlKey || event.metaKey || event.altKey) return false;
		const instrument = this.target.instrument();
		if (!instrument) return false;
		const action = jamActionForKey(this.map, instrument, event.code, event.shiftKey);
		if (action.kind === 'none') return false;
		if (event.repeat || this.held.has(event.code) || this.bendCode === event.code) return true;
		switch (action.kind) {
			case 'octave':
				this.target.shiftOctave(action.delta);
				return true;
			case 'bend':
				this.bendCode = event.code;
				this.target.play({kind: 'bendOn', semitones: action.semitones}, event.timeStamp);
				this.target.showBend(action.semitones);
				return true;
			case 'lane':
				this.pressLane(event.code, action.lane, action.alternate, instrument, event.timeStamp);
				return true;
		}
	}

	keyUp(event: Pick<KeyboardEvent, 'code' | 'timeStamp'>): boolean {
		if (event.code === this.bendCode) {
			this.bendCode = null;
			this.target.play({kind: 'bendOff'}, event.timeStamp);
			this.target.showBend(0);
			return true;
		}
		const held = this.held.get(event.code);
		if (!held) return false;
		this.held.delete(event.code);
		if (this.lastPress?.code === event.code) this.lastPress = null;
		this.target.showLane(held.lane, this.isLaneHeld(held.lane), false);
		if (held.note !== null && !this.isNoteHeld(held.note)) {
			this.target.play({kind: 'noteOff', note: held.note}, event.timeStamp);
		}
		return true;
	}

	// Focus left or the instrument changed: nothing may keep sounding without its key.
	releaseAll(timeStamp: number): void {
		const notes = new Set<number>();
		for (const held of this.held.values()) {
			if (held.note !== null) notes.add(held.note);
			this.target.showLane(held.lane, false, false);
		}
		this.held.clear();
		this.lastPress = null;
		for (const note of notes) this.target.play({kind: 'noteOff', note}, timeStamp);
		if (this.bendCode !== null) {
			this.bendCode = null;
			this.target.play({kind: 'bendOff'}, timeStamp);
			this.target.showBend(0);
		}
	}

	private pressLane(
		code: string,
		lane: number,
		alternate: boolean,
		instrument: BandJamInstrument,
		timeStamp: number,
	): void {
		if (instrument === 'guitar' && this.pinch(code, lane, timeStamp)) return;
		const sound = this.target.laneSound(lane, alternate, false);
		if (!sound) return;
		this.target.play({kind: 'noteOn', note: sound.note, ...sound.options}, timeStamp);
		this.held.set(code, {lane, note: instrument === 'drums' ? null : sound.note, pinch: false});
		this.lastPress = {code, lane, at: timeStamp};
		this.target.showLane(lane, true, false);
	}

	// The first key of the pair already sounded its own note; the pinch takes over from it on the lower lane and both
	// keys hold the squeal until the last of them comes up.
	private pinch(code: string, lane: number, timeStamp: number): boolean {
		const previous = this.lastPress;
		const partner = previous ? this.held.get(previous.code) : undefined;
		if (!previous || !partner || partner.pinch) return false;
		const lower = pinchLane(previous, lane, timeStamp);
		if (lower === null) return false;
		const sound = this.target.laneSound(lower, false, true);
		if (!sound) return false;
		if (partner.note !== null) this.target.play({kind: 'noteOff', note: partner.note}, timeStamp);
		this.target.play({kind: 'noteOn', note: sound.note, ...sound.options}, timeStamp);
		this.held.set(previous.code, {lane: previous.lane, note: sound.note, pinch: true});
		this.held.set(code, {lane, note: sound.note, pinch: true});
		this.lastPress = null;
		this.target.showLane(previous.lane, true, true);
		this.target.showLane(lane, true, true);
		return true;
	}

	private isNoteHeld(note: number): boolean {
		for (const held of this.held.values()) if (held.note === note) return true;
		return false;
	}

	private isLaneHeld(lane: number): boolean {
		for (const held of this.held.values()) if (held.lane === lane) return true;
		return false;
	}
}
