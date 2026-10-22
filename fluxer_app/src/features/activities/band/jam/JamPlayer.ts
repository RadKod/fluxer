// SPDX-License-Identifier: AGPL-3.0-or-later

// Drives the jam instruments from events: my own play sounds at once and goes out as a message; each other
// player's messages are scheduled on the shared session clock behind a fixed jitter buffer, on that player's own
// instrument. The jam screen's runtime (JamRuntime) feeds receive() and sends through the activity session.

import type {AudioClockAnchor} from '@app/features/activities/band/engine/SessionClock';
import {readAudioAnchor} from '@app/features/activities/band/game/BandAudio';
import {
	JAM_DEFAULT_VELOCITY,
	type JamMixer,
	type JamNoteOptions,
	type JamPlayable,
} from '@app/features/activities/band/jam/JamInstruments';
import {
	decodeJamMessage,
	encodeJamEvents,
	JAM_JITTER_BUFFER_MS,
	type JamEvent,
	type JamMessage,
	remoteEventContextTime,
} from '@app/features/activities/band/jam/JamMessages';
import type {JamInstrument} from '@app/features/activities/band/jam/JamScales';
import type {BendSemitones} from '@app/features/activities/band/jam/JamTechniques';

// The part of the activity session's clock the player needs.
export interface JamClock {
	readonly offsetMs: number;
	now(): number;
}

export type JamAction =
	| ({readonly kind: 'noteOn'; readonly note: number} & JamNoteOptions)
	| {readonly kind: 'noteOff'; readonly note: number}
	| {readonly kind: 'bendOn'; readonly semitones: BendSemitones}
	| {readonly kind: 'bendOff'};

// A remote note off never lands before its note on, and never so close that the note does not sound.
export const JAM_MIN_REMOTE_NOTE_S = 0.03;
// A remote note held this long is let go when the player's next note arrives: a lost note off cannot hang forever.
export const JAM_REMOTE_MAX_HOLD_S = 20;

interface RemoteState {
	readonly playable: JamPlayable;
	readonly held: Map<number, number>;
	lastTime: number;
}

// Remote events of one player keep their order on the audio clock even when late ones are pulled forward.
export function orderedRemoteTime(
	event: JamEvent,
	scheduled: number,
	state: Pick<RemoteState, 'held' | 'lastTime'>,
): number {
	let time = Math.max(scheduled, state.lastTime);
	if (event.kind === 'noteOff') {
		const on = state.held.get(event.note);
		if (on !== undefined) time = Math.max(time, on + JAM_MIN_REMOTE_NOTE_S);
	}
	return time;
}

export interface JamPlayerOptions {
	readonly jitterMs?: number;
	readonly send?: (message: JamMessage) => void;
	readonly readAnchor?: () => AudioClockAnchor;
	// Remote events that arrived past their slot, for diagnostics.
	readonly onLate?: (participantId: string, lateMs: number) => void;
	// Every remote event with the AudioContext time it sounds at, so a view can light it up when it is heard.
	readonly onScheduled?: (participantId: string, event: JamEvent, contextTime: number) => void;
}

export class JamPlayer {
	private local: JamPlayable | null = null;
	private readonly remotes = new Map<string, RemoteState>();
	private readonly jitterMs: number;
	private readonly readAnchor: () => AudioClockAnchor;

	constructor(
		private readonly mixer: JamMixer,
		private readonly clock: JamClock,
		private readonly options: JamPlayerOptions = {},
	) {
		this.jitterMs = options.jitterMs ?? JAM_JITTER_BUFFER_MS;
		const {context} = mixer;
		this.readAnchor =
			options.readAnchor ??
			(() => {
				if (!(context instanceof AudioContext)) throw new TypeError('Remote jam events need a realtime context');
				return readAudioAnchor(context);
			});
	}

	get localInstrument(): JamInstrument | null {
		return this.local?.instrument ?? null;
	}

	setLocalInstrument(instrument: JamInstrument | null): void {
		if (this.local?.instrument === instrument) return;
		this.local?.dispose();
		this.local = instrument ? this.mixer.create(instrument) : null;
	}

	// Plays at once and sends the event. `performanceTime` is the input event's timeStamp, so the stamp on the wire
	// is when the key went down rather than when this ran. Returns the AudioContext time the sound starts at.
	play(action: JamAction, performanceTime?: number): number {
		const contextTime = this.mixer.context.currentTime;
		if (!this.local) return contextTime;
		const sessionTime =
			performanceTime === undefined ? this.clock.now() : performance.timeOrigin + performanceTime + this.clock.offsetMs;
		const event = eventFromAction(action, sessionTime);
		apply(this.local, event, contextTime);
		this.options.send?.(encodeJamEvents([event]));
		return contextTime;
	}

	setRemoteInstrument(participantId: string, instrument: JamInstrument): void {
		const existing = this.remotes.get(participantId);
		if (existing?.playable.instrument === instrument) return;
		existing?.playable.dispose();
		this.remotes.set(participantId, {playable: this.mixer.create(instrument), held: new Map(), lastTime: 0});
	}

	removeRemote(participantId: string): void {
		this.remotes.get(participantId)?.playable.dispose();
		this.remotes.delete(participantId);
	}

	// A message from another player. Unknown senders and malformed messages are dropped.
	receive(participantId: string, payload: unknown): void {
		const state = this.remotes.get(participantId);
		if (!state) return;
		const events = decodeJamMessage(payload, this.clock.now());
		if (!events) return;
		const anchor = this.readAnchor();
		const now = this.mixer.context.currentTime;
		for (const event of events) {
			const schedule = remoteEventContextTime(event.time, this.clock.offsetMs, anchor, now, this.jitterMs);
			if (schedule.lateMs > 0) this.options.onLate?.(participantId, schedule.lateMs);
			const time = orderedRemoteTime(event, schedule.contextTime, state);
			state.lastTime = time;
			if (event.kind === 'noteOn') {
				for (const [note, on] of state.held) {
					if (time - on > JAM_REMOTE_MAX_HOLD_S) {
						state.playable.noteOff(note, time);
						state.held.delete(note);
					}
				}
				state.held.set(event.note, time);
			} else if (event.kind === 'noteOff') {
				state.held.delete(event.note);
			}
			apply(state.playable, event, time);
			this.options.onScheduled?.(participantId, event, time);
		}
	}

	allNotesOff(): void {
		const now = this.mixer.context.currentTime;
		this.local?.allNotesOff(now);
		for (const state of this.remotes.values()) {
			state.playable.allNotesOff(now);
			state.held.clear();
		}
	}

	dispose(): void {
		this.local?.dispose();
		this.local = null;
		for (const state of this.remotes.values()) state.playable.dispose();
		this.remotes.clear();
	}
}

function eventFromAction(action: JamAction, time: number): JamEvent {
	switch (action.kind) {
		case 'noteOn':
			return {
				kind: 'noteOn',
				time,
				note: action.note,
				velocity: action.velocity ?? JAM_DEFAULT_VELOCITY,
				pinchHarmonic: action.pinchHarmonic ?? 0,
				powerChord: action.powerChord === true,
				clean: action.clean === true,
			};
		case 'noteOff':
			return {kind: 'noteOff', time, note: action.note};
		case 'bendOn':
			return {kind: 'bendOn', time, semitones: action.semitones};
		case 'bendOff':
			return {kind: 'bendOff', time};
	}
}

function apply(playable: JamPlayable, event: JamEvent, time: number): void {
	switch (event.kind) {
		case 'noteOn':
			playable.noteOn(event.note, time, {
				velocity: event.velocity,
				pinchHarmonic: event.pinchHarmonic,
				powerChord: event.powerChord,
				clean: event.clean,
			});
			break;
		case 'noteOff':
			playable.noteOff(event.note, time);
			break;
		case 'bendOn':
			playable.bendOn(event.semitones, time);
			break;
		case 'bendOff':
			playable.bendOff(time);
			break;
	}
}
