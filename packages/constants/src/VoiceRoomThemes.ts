// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ROOM_THEME_MANIFEST} from '@fluxer/constants/src/VoiceRoomThemeManifest';

// LiveKit participant attribute the API writes with the seat name; clients only read it.
export const VOICE_SEAT_ATTRIBUTE = 'micup.seat';

export type VoiceRoomTheme = keyof typeof VOICE_ROOM_THEME_MANIFEST;

export const VOICE_ROOM_THEME_IDS = Object.keys(VOICE_ROOM_THEME_MANIFEST) as unknown as readonly [
	VoiceRoomTheme,
	...Array<VoiceRoomTheme>,
];

export function isVoiceRoomTheme(value: unknown): value is VoiceRoomTheme {
	return typeof value === 'string' && Object.hasOwn(VOICE_ROOM_THEME_MANIFEST, value);
}

export type ParsedSeatName =
	| {kind: 'lounge'; group: string; index: number}
	| {kind: 'table'; slot: string; position: 1 | 2 | 3 | 4}
	| {kind: 'watch'; slot: string; index: 1 | 2 | 3 | 4};

const LOUNGE_SEAT_NAME = /^seat_([A-Z][A-Z0-9]*)_([0-9]{2})$/;
const TABLE_SEAT_NAME = /^seat_(T[0-9]{2})_([1-4])$/;
// Watch seats beside a table: matches neither the lounge nor the table pattern.
const WATCH_SEAT_NAME = /^seat_(T[0-9]{2})_Y([1-4])$/;

export function parseSeatName(name: string): ParsedSeatName | null {
	const table = TABLE_SEAT_NAME.exec(name);
	if (table) return {kind: 'table', slot: table[1]!, position: Number(table[2]) as 1 | 2 | 3 | 4};
	const watch = WATCH_SEAT_NAME.exec(name);
	if (watch) return {kind: 'watch', slot: watch[1]!, index: Number(watch[2]) as 1 | 2 | 3 | 4};
	const lounge = LOUNGE_SEAT_NAME.exec(name);
	if (lounge) return {kind: 'lounge', group: lounge[1]!, index: Number(lounge[2])};
	return null;
}

export function tableSeatName(slot: string, position: number): string {
	return `seat_${slot}_${position}`;
}

export function watchSeatName(slot: string, index: number): string {
	return `seat_${slot}_Y${index}`;
}

export function themeLoungeSeats(theme: VoiceRoomTheme): ReadonlyArray<string> {
	return VOICE_ROOM_THEME_MANIFEST[theme].seats;
}

export function themeTableSlots(theme: VoiceRoomTheme): ReadonlyArray<string> {
	return VOICE_ROOM_THEME_MANIFEST[theme].tables.map((table) => table.slot);
}

export function themeWatchSeats(theme: VoiceRoomTheme): ReadonlyArray<string> {
	return VOICE_ROOM_THEME_MANIFEST[theme].watch_seats;
}
