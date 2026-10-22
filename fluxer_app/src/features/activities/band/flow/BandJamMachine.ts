// SPDX-License-Identifier: AGPL-3.0-or-later

// Jam mode's part of the room rules, run only on the leader beside BandRoomMachine. Like it, every function returns
// the same object when nothing changed.

import {
	BAND_JAM_BPM_MAX,
	BAND_JAM_BPM_MIN,
	BAND_JAM_INSTRUMENTS,
	type BandJamInstrument,
	type BandJamIntent,
	type BandJamSeat,
	type BandJamSettingsPatch,
	type BandState,
} from '@app/features/activities/band/BandProtocol';
import {
	JAM_BACKING_PATTERNS,
	JAM_BACKING_STYLES,
	type JamBackingStyle,
} from '@app/features/activities/band/jam/JamBacking';
import {
	JAM_DEFAULT_KEY,
	JAM_DEFAULT_SCALE,
	JAM_SCALES,
	type JamScale,
} from '@app/features/activities/band/jam/JamScales';

export type BandJamState = Extract<BandState, {phase: 'jam'}>;

export const BAND_JAM_DEFAULT_STYLE: JamBackingStyle = 'rock';
// A (re)started loop begins this far in the leader's future, so the state reaches everyone before its first beat and
// every client comes in on the downbeat with the crash, not a few steps into the bar.
export const BAND_JAM_BACKING_LEAD_MS = 600;

export function startJam(now: number): BandJamState {
	return {
		phase: 'jam',
		key: JAM_DEFAULT_KEY,
		scale: JAM_DEFAULT_SCALE,
		backing: {
			style: BAND_JAM_DEFAULT_STYLE,
			bpm: JAM_BACKING_PATTERNS[BAND_JAM_DEFAULT_STYLE].bpm,
			on: true,
			since: now + BAND_JAM_BACKING_LEAD_MS,
		},
		seats: [],
		openedAt: now,
	};
}

function clampBpm(bpm: number): number {
	return Math.min(BAND_JAM_BPM_MAX, Math.max(BAND_JAM_BPM_MIN, Math.round(bpm)));
}

// A new style brings its own tempo unless the same patch sets one. Key and scale changes keep the loop running; a new
// style, tempo or switching it on starts it again from the first step.
export function applyJamSettings(state: BandJamState, patch: BandJamSettingsPatch, now: number): BandJamState {
	const key = patch.key ?? state.key;
	const scale = patch.scale ?? state.scale;
	const style = patch.style ?? state.backing.style;
	const styleChanged = style !== state.backing.style;
	const bpm = clampBpm(patch.bpm ?? (styleChanged ? JAM_BACKING_PATTERNS[style].bpm : state.backing.bpm));
	const on = patch.backing ?? state.backing.on;
	const restart = styleChanged || bpm !== state.backing.bpm || (on && !state.backing.on);
	if (key === state.key && scale === state.scale && !restart && on === state.backing.on) return state;
	return {
		...state,
		key,
		scale,
		backing: {style, bpm, on, since: restart ? now + BAND_JAM_BACKING_LEAD_MS : state.backing.since},
	};
}

export function setJamInstrument(
	state: BandJamState,
	instrument: BandJamInstrument | null,
	fromUserId: string,
): BandJamState {
	const current = state.seats.find((seat) => seat.userId === fromUserId);
	if ((current?.instrument ?? null) === instrument) return state;
	const others = state.seats.filter((seat) => seat !== current);
	return {...state, seats: instrument === null ? others : [...others, {userId: fromUserId, instrument}]};
}

export function dropAbsentJamSeats(state: BandJamState, presentUserIds: ReadonlySet<string>): BandJamState {
	const seats = state.seats.filter((seat) => presentUserIds.has(seat.userId));
	return seats.length === state.seats.length ? state : {...state, seats};
}

export function isJamInstrument(value: unknown): value is BandJamInstrument {
	return typeof value === 'string' && (BAND_JAM_INSTRUMENTS as ReadonlyArray<string>).includes(value);
}

function isJamScale(value: unknown): value is JamScale {
	return typeof value === 'string' && Object.hasOwn(JAM_SCALES, value);
}

function isBackingStyle(value: unknown): value is JamBackingStyle {
	return typeof value === 'string' && (JAM_BACKING_STYLES as ReadonlyArray<string>).includes(value);
}

function isKey(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 12;
}

// A settings intent is dropped whole when any field it carries is malformed.
function parseJamSettings(record: Record<string, unknown>): BandJamIntent | null {
	const {key, scale, style, bpm, backing} = record;
	if (key !== undefined && !isKey(key)) return null;
	if (scale !== undefined && !isJamScale(scale)) return null;
	if (style !== undefined && !isBackingStyle(style)) return null;
	if (bpm !== undefined && !(typeof bpm === 'number' && Number.isFinite(bpm))) return null;
	if (backing !== undefined && typeof backing !== 'boolean') return null;
	return {
		t: 'band.jamSettings',
		...(key !== undefined && {key}),
		...(scale !== undefined && {scale}),
		...(style !== undefined && {style}),
		...(bpm !== undefined && {bpm}),
		...(backing !== undefined && {backing}),
	};
}

export function parseJamIntent(record: Record<string, unknown>): BandJamIntent | null {
	switch (record.t) {
		case 'band.jamStart':
			return {t: 'band.jamStart'};
		case 'band.jamEnd':
			return {t: 'band.jamEnd'};
		case 'band.jamSettings':
			return parseJamSettings(record);
		case 'band.jamInstrument':
			return record.instrument === null || isJamInstrument(record.instrument)
				? {t: 'band.jamInstrument', instrument: record.instrument}
				: null;
		default:
			return null;
	}
}

export function jamSeatOf(state: BandJamState, userId: string): BandJamSeat | undefined {
	return state.seats.find((seat) => seat.userId === userId);
}
