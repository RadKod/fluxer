// SPDX-License-Identifier: AGPL-3.0-or-later

import {PutVoiceSeatRequest, VoiceSeatResponse} from '@fluxer/schema/src/domains/voice_seat/VoiceSeatSchemas';
import {describe, expect, test} from 'vitest';

describe('voice seat schemas', () => {
	test('rejects table seat names in PUT', () => {
		for (const seat of ['seat_T01_1', 'seat_T01_4', 'stand_01', 'seat_a_01', 'seat_A_1']) {
			expect(PutVoiceSeatRequest.safeParse({connection_id: 'abc', seat}).success).toBe(false);
		}
		expect(PutVoiceSeatRequest.parse({connection_id: 'abc', seat: 'seat_A_01'}).seat).toBe('seat_A_01');
		expect(PutVoiceSeatRequest.safeParse({connection_id: '', seat: 'seat_A_01'}).success).toBe(false);
		expect(PutVoiceSeatRequest.safeParse({connection_id: 'x'.repeat(65), seat: null}).success).toBe(false);
	});

	test('accepts null seat', () => {
		expect(PutVoiceSeatRequest.parse({connection_id: 'abc', seat: null})).toEqual({connection_id: 'abc', seat: null});
		expect(PutVoiceSeatRequest.safeParse({connection_id: 'abc'}).success).toBe(false);
		expect(VoiceSeatResponse.parse({seat: null})).toEqual({seat: null});
	});

	test('PUT accepts lounge and watch seat names, rejects table seat names', () => {
		for (const seat of ['seat_A_01', 'seat_T01_05', 'seat_T01_Y1', 'seat_T02_Y4']) {
			expect(PutVoiceSeatRequest.parse({connection_id: 'abc', seat}).seat).toBe(seat);
		}
		for (const seat of ['seat_T01_1', 'seat_T01_4', 'seat_T01_Y0', 'seat_T01_Y5', 'seat_T1_Y1', 'seat_T01_y1']) {
			expect(PutVoiceSeatRequest.safeParse({connection_id: 'abc', seat}).success, seat).toBe(false);
		}
	});
});
