// SPDX-License-Identifier: AGPL-3.0-or-later

// Wire format of jam events and when a remote one should sound.
//
// One message carries one or more events as a flat number array: {t: 'band.jam', e: [kind, time, ...args, ...]}.
//   0 note on   [0, time, note, velocity 1..127, flags]   flags: 1 power chord, 2 clean guitar tone,
//                                                           pinch harmonic k (2..7, 0 for none) times 4
//   1 note off  [1, time, note]
//   2 bend on   [2, time, semitones 1..3]
//   3 bend off  [3, time]
// `note` is a MIDI number, or an index into JAM_DRUM_PIECES for drums. `time` is the shared session clock in ms,
// sent modulo 2^20 (about 17 minutes) and unwrapped against the receiver's clock: six digits instead of thirteen.
// A note on is about 40 bytes of JSON in the activity envelope.
//
// Send these reliable (the session default). Lossy has no retransmission, and a lost note off or bend off would
// leave a note hanging on every other client; the event rate is a few per second, so the cost of reliable is only
// that a retransmitted event arrives about one round trip late and plays late instead of never. Reliable is also
// ordered, so a note off cannot overtake its note on.

import type {AudioClockAnchor} from '@app/features/activities/band/engine/SessionClock';
import {sessionToContextTime} from '@app/features/activities/band/engine/SessionClock';
import type {BendSemitones} from '@app/features/activities/band/jam/JamTechniques';

export const JAM_MESSAGE_TYPE = 'band.jam';
export const JAM_TIME_WRAP_MS = 2 ** 20;
// Remote notes are played this long after they were played, so network jitter up to it is absorbed.
export const JAM_JITTER_BUFFER_MS = 90;
// A remote event further ahead than this means the clocks disagree; it plays after the jitter buffer instead.
export const JAM_MAX_SCHEDULE_AHEAD_MS = 1000;

const NOTE_ON = 0;
const NOTE_OFF = 1;
const BEND_ON = 2;
const BEND_OFF = 3;
const FLAG_POWER_CHORD = 1;
const FLAG_CLEAN = 2;
const PINCH_SHIFT = 2;
const MAX_HARMONIC = 7;
const MAX_NOTE = 127;

export type JamEvent =
	| {
			readonly kind: 'noteOn';
			readonly time: number;
			readonly note: number;
			// 0..1
			readonly velocity: number;
			// The harmonic a pinch brings out; 0 for a plain note.
			readonly pinchHarmonic: number;
			readonly powerChord: boolean;
			readonly clean: boolean;
	  }
	| {readonly kind: 'noteOff'; readonly time: number; readonly note: number}
	| {readonly kind: 'bendOn'; readonly time: number; readonly semitones: BendSemitones}
	| {readonly kind: 'bendOff'; readonly time: number};

export interface JamMessage {
	readonly t: typeof JAM_MESSAGE_TYPE;
	readonly e: ReadonlyArray<number>;
}

export function wrapSessionTime(sessionMs: number): number {
	return ((Math.round(sessionMs) % JAM_TIME_WRAP_MS) + JAM_TIME_WRAP_MS) % JAM_TIME_WRAP_MS;
}

// The session time nearest `nowMs` whose wrapped value is `wrapped`.
export function unwrapSessionTime(wrapped: number, nowMs: number): number {
	const base = nowMs - wrapSessionTime(nowMs);
	let time = base + wrapped;
	if (time - nowMs > JAM_TIME_WRAP_MS / 2) time -= JAM_TIME_WRAP_MS;
	else if (nowMs - time > JAM_TIME_WRAP_MS / 2) time += JAM_TIME_WRAP_MS;
	return time;
}

function pinchHarmonicField(harmonic: number): number {
	return Number.isInteger(harmonic) && harmonic >= 2 && harmonic <= MAX_HARMONIC ? harmonic : 0;
}

function velocityByte(velocity: number): number {
	return Math.min(127, Math.max(1, Math.round(velocity * 127)));
}

export function encodeJamEvents(events: ReadonlyArray<JamEvent>): JamMessage {
	const e: Array<number> = [];
	for (const event of events) {
		const time = wrapSessionTime(event.time);
		switch (event.kind) {
			case 'noteOn':
				e.push(
					NOTE_ON,
					time,
					event.note,
					velocityByte(event.velocity),
					(event.powerChord ? FLAG_POWER_CHORD : 0) |
						(event.clean ? FLAG_CLEAN : 0) |
						(pinchHarmonicField(event.pinchHarmonic) << PINCH_SHIFT),
				);
				break;
			case 'noteOff':
				e.push(NOTE_OFF, time, event.note);
				break;
			case 'bendOn':
				e.push(BEND_ON, time, event.semitones);
				break;
			case 'bendOff':
				e.push(BEND_OFF, time);
				break;
		}
	}
	return {t: JAM_MESSAGE_TYPE, e};
}

function isInteger(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isJamMessage(payload: unknown): payload is JamMessage {
	return (
		typeof payload === 'object' &&
		payload !== null &&
		(payload as {t?: unknown}).t === JAM_MESSAGE_TYPE &&
		Array.isArray((payload as {e?: unknown}).e)
	);
}

// Null for anything malformed: a message is taken whole or not at all.
export function decodeJamMessage(payload: unknown, receiverNowMs: number): ReadonlyArray<JamEvent> | null {
	if (!isJamMessage(payload)) return null;
	const e: ReadonlyArray<unknown> = payload.e;
	const events: Array<JamEvent> = [];
	let i = 0;
	while (i < e.length) {
		const kind = e[i];
		const wrapped = e[i + 1];
		if (!isInteger(wrapped, 0, JAM_TIME_WRAP_MS - 1)) return null;
		const time = unwrapSessionTime(wrapped, receiverNowMs);
		if (kind === NOTE_ON) {
			const [note, velocity, flags] = [e[i + 2], e[i + 3], e[i + 4]];
			if (!isInteger(note, 0, MAX_NOTE) || !isInteger(velocity, 1, 127) || !isInteger(flags, 0, 31)) return null;
			const pinchHarmonic = flags >> PINCH_SHIFT;
			if (pinchHarmonic === 1) return null;
			events.push({
				kind: 'noteOn',
				time,
				note,
				velocity: velocity / 127,
				pinchHarmonic,
				powerChord: (flags & FLAG_POWER_CHORD) !== 0,
				clean: (flags & FLAG_CLEAN) !== 0,
			});
			i += 5;
		} else if (kind === NOTE_OFF) {
			const note = e[i + 2];
			if (!isInteger(note, 0, MAX_NOTE)) return null;
			events.push({kind: 'noteOff', time, note});
			i += 3;
		} else if (kind === BEND_ON) {
			const semitones = e[i + 2];
			if (semitones !== 1 && semitones !== 2 && semitones !== 3) return null;
			events.push({kind: 'bendOn', time, semitones});
			i += 3;
		} else if (kind === BEND_OFF) {
			events.push({kind: 'bendOff', time});
			i += 2;
		} else {
			return null;
		}
	}
	return events;
}

export interface RemoteSchedule {
	// AudioContext time to play the event at.
	readonly contextTime: number;
	// How far past its slot the event arrived; 0 when it was in time.
	readonly lateMs: number;
}

// A remote event plays jitterMs after the moment it was played, on this client's AudioContext clock. Late events
// play at once; events implausibly far ahead (clock trouble) play one jitter buffer from now.
export function remoteEventContextTime(
	eventSessionMs: number,
	clockOffsetMs: number,
	anchor: AudioClockAnchor,
	nowContextTime: number,
	jitterMs = JAM_JITTER_BUFFER_MS,
): RemoteSchedule {
	const target = sessionToContextTime(eventSessionMs + jitterMs, clockOffsetMs, anchor);
	if (target < nowContextTime) return {contextTime: nowContextTime, lateMs: (nowContextTime - target) * 1000};
	if (target > nowContextTime + JAM_MAX_SCHEDULE_AHEAD_MS / 1000) {
		return {contextTime: nowContextTime + jitterMs / 1000, lateMs: 0};
	}
	return {contextTime: target, lateMs: 0};
}
