// SPDX-License-Identifier: AGPL-3.0-or-later

import {VOICE_ROOM_THEME_MANIFEST} from '@fluxer/constants/src/VoiceRoomThemeManifest';
import {
	isVoiceRoomTheme,
	parseSeatName,
	tableSeatName,
	themeLoungeSeats,
	themeTableSlots,
	themeWatchSeats,
	VOICE_ROOM_THEME_IDS,
	watchSeatName,
} from '@fluxer/constants/src/VoiceRoomThemes';
import {describe, expect, test} from 'vitest';

describe('voice room themes', () => {
	test('parseSeatName separates lounge and table seats', () => {
		expect(parseSeatName('seat_A_01')).toEqual({kind: 'lounge', group: 'A', index: 1});
		expect(parseSeatName('seat_B2_12')).toEqual({kind: 'lounge', group: 'B2', index: 12});
		expect(parseSeatName('seat_T02_4')).toEqual({kind: 'table', slot: 'T02', position: 4});
		for (const name of ['seat_a_01', 'seat_A_1', 'seat_A_001', 'seat_T01_5', 'seat_T01_0', 'stand_01', '']) {
			expect(parseSeatName(name)).toBeNull();
		}
		expect(tableSeatName('T01', 3)).toBe('seat_T01_3');
	});

	test('seat_T01_1 is a table seat, seat_T01_01 is a lounge seat', () => {
		expect(parseSeatName('seat_T01_1')).toEqual({kind: 'table', slot: 'T01', position: 1});
		expect(parseSeatName('seat_T01_01')).toEqual({kind: 'lounge', group: 'T01', index: 1});
	});

	test('manifest lounge seats exclude table seats and keep group order', () => {
		expect(VOICE_ROOM_THEME_IDS.length).toBeGreaterThan(0);
		for (const theme of VOICE_ROOM_THEME_IDS) {
			const seats = themeLoungeSeats(theme);
			expect(seats.length).toBeGreaterThan(0);
			const parsed = seats.map((seat) => parseSeatName(seat));
			for (const seat of parsed) expect(seat?.kind).toBe('lounge');
			const order = parsed.map((seat) => (seat?.kind === 'lounge' ? [seat.group, seat.index] : null));
			const sorted = [...order].sort((a, b) =>
				a![0] === b![0] ? (a![1] as number) - (b![1] as number) : a![0] < b![0] ? -1 : 1,
			);
			expect(order).toEqual(sorted);
			expect(themeTableSlots(theme)).toEqual(VOICE_ROOM_THEME_MANIFEST[theme].tables.map((table) => table.slot));
			for (const slot of themeTableSlots(theme)) expect(slot).toMatch(/^T[0-9]{2}$/);
		}
	});

	test('seat_T01_Y1 is a watch seat of T01', () => {
		expect(parseSeatName('seat_T01_Y1')).toEqual({kind: 'watch', slot: 'T01', index: 1});
		expect(parseSeatName('seat_T12_Y4')).toEqual({kind: 'watch', slot: 'T12', index: 4});
		for (const name of ['seat_T01_Y0', 'seat_T01_Y5', 'seat_T1_Y1', 'seat_t01_Y1', 'seat_T01_y1', 'seat_T01_Y01']) {
			expect(parseSeatName(name)).toBeNull();
		}
	});

	test('seat_T01_5 and seat_T01_05 are not watch seats (table / lounge)', () => {
		expect(parseSeatName('seat_T01_5')).toBeNull();
		expect(parseSeatName('seat_T01_05')).toEqual({kind: 'lounge', group: 'T01', index: 5});
		expect(parseSeatName('seat_T01_4')).toEqual({kind: 'table', slot: 'T01', position: 4});
	});

	test('manifest watch seats never appear in lounge seats', () => {
		for (const theme of VOICE_ROOM_THEME_IDS) {
			const watch = themeWatchSeats(theme);
			const lounge = new Set(themeLoungeSeats(theme));
			const slots = themeTableSlots(theme);
			const keys = watch.map((seat) => {
				const parsed = parseSeatName(seat);
				expect(parsed?.kind).toBe('watch');
				expect(lounge.has(seat)).toBe(false);
				if (parsed?.kind !== 'watch') throw new Error(seat);
				expect(slots).toContain(parsed.slot);
				return `${parsed.slot}:${parsed.index}`;
			});
			expect(keys).toEqual([...keys].sort());
			expect(new Set(watch).size).toBe(watch.length);
		}
	});

	test('watchSeatName round trip', () => {
		for (const slot of ['T01', 'T02', 'T99']) {
			for (const index of [1, 2, 3, 4] as const) {
				const name = watchSeatName(slot, index);
				expect(name).toBe(`seat_${slot}_Y${index}`);
				expect(parseSeatName(name)).toEqual({kind: 'watch', slot, index});
			}
		}
	});

	test('isVoiceRoomTheme rejects unknown and non-string', () => {
		expect(isVoiceRoomTheme(VOICE_ROOM_THEME_IDS[0])).toBe(true);
		for (const value of ['unknown-room', '', 'toString', '__proto__', null, undefined, 1, {}]) {
			expect(isVoiceRoomTheme(value)).toBe(false);
		}
	});
});
