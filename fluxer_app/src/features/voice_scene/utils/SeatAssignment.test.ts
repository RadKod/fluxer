// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomLayout} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {
	assignSeats,
	freeLoungeSeatCount,
	VOICE_SCENE_STANDING_CAP,
} from '@app/features/voice_scene/utils/SeatAssignment';
import {describe, expect, it} from 'vitest';

const LAYOUT: RoomLayout = {
	seats: [
		{name: 'seat_A_01', group: 'A', position: {x: 1, y: 1, z: 0}, table: null, watch: null},
		{name: 'seat_A_02', group: 'A', position: {x: 2, y: 1, z: 0}, table: null, watch: null},
		{name: 'seat_B_01', group: 'B', position: {x: 3, y: 1, z: 0}, table: null, watch: null},
		{name: 'seat_T01_1', group: 'T01', position: {x: 4, y: 1, z: 0}, table: {slot: 'T01', position: 1}, watch: null},
		{name: 'seat_T01_Y1', group: 'T01', position: {x: 4, y: 1, z: 2}, table: null, watch: {slot: 'T01', index: 1}},
	],
	stands: [
		{x: 10, y: 1, z: 0},
		{x: 11, y: 1, z: 0},
	],
	tables: [{slot: 'T01', center: {x: 4, y: 0.8, z: 1}, topSize: 1}],
	camTarget: {x: 0, y: 0, z: 0},
	camHome: {x: 0, y: 5, z: 8},
	screen: null,
	camPan: {x: 0, z: 0},
};

const p = (userId: string, connectionId = 'c') => ({userId, connectionId});
const id = (userId: string, connectionId = 'c') => `user_${userId}_${connectionId}`;

describe('assignSeats', () => {
	it('maps participants with micup.seat to seats', () => {
		const result = assignSeats(
			[p('1'), p('2')],
			new Map([
				[id('1'), 'seat_A_02'],
				[id('2'), 'seat_T01_1'],
			]),
			LAYOUT,
		);
		expect(result.seated.get('seat_A_02')).toEqual(p('1'));
		expect(result.seated.get('seat_T01_1')).toEqual(p('2'));
		expect(result.standing).toEqual([]);
		expect(result.placements.get('1')).toEqual({position: {x: 2, y: 1, z: 0}, seat: 'seat_A_02'});
	});

	it('participants without the attribute stand', () => {
		const result = assignSeats([p('1'), p('2')], new Map([[id('1'), 'seat_A_01']]), LAYOUT);
		expect(result.standing).toEqual([p('2')]);
		expect(result.placements.get('2')).toEqual({position: {x: 10, y: 1, z: 0}, seat: null});
	});

	it('a seat name absent from the layout renders the participant standing', () => {
		const result = assignSeats([p('1')], new Map([[id('1'), 'seat_Z_09']]), LAYOUT);
		expect(result.seated.size).toBe(0);
		expect(result.standing).toEqual([p('1')]);
	});

	it('one entry per user when two identities exist (seated one wins)', () => {
		const phone = p('1', 'phone');
		const desktop = p('1', 'desk');
		const result = assignSeats([phone, desktop], new Map([[id('1', 'desk'), 'seat_B_01']]), LAYOUT);
		expect(result.seated.get('seat_B_01')).toBe(desktop);
		expect(result.standing).toEqual([]);
		expect(result.placements.get('1')?.seat).toBe('seat_B_01');
	});

	it('two users claiming one seat: the first is drawn there, the other stands', () => {
		const result = assignSeats(
			[p('1'), p('2')],
			new Map([
				[id('1'), 'seat_A_01'],
				[id('2'), 'seat_A_01'],
			]),
			LAYOUT,
		);
		expect(result.seated.get('seat_A_01')).toEqual(p('1'));
		expect(result.standing).toEqual([p('2')]);
	});

	it('standing beyond the cap (24) yields +N overflow', () => {
		const crowd = Array.from({length: VOICE_SCENE_STANDING_CAP + 7}, (_, index) => p(String(100 + index)));
		const result = assignSeats(crowd, new Map(), LAYOUT);
		expect(VOICE_SCENE_STANDING_CAP).toBe(24);
		expect(result.standing).toHaveLength(24);
		expect(result.overflow).toBe(7);
		// Everyone still has a place to be heard from, overflow included; stands are reused in turn.
		expect(result.placements.size).toBe(31);
		expect(result.placements.get('130')?.position).toEqual({x: 10, y: 1, z: 0});
		expect(result.placements.get('101')?.position).toEqual({x: 11, y: 1, z: 0});
	});

	it('watch seats are seated places', () => {
		const result = assignSeats([p('1')], new Map([[id('1'), 'seat_T01_Y1']]), LAYOUT);
		expect(result.seated.get('seat_T01_Y1')).toEqual(p('1'));
		expect(result.placements.get('1')).toEqual({position: {x: 4, y: 1, z: 2}, seat: 'seat_T01_Y1'});
	});

	it('a watch seat absent from the layout renders standing', () => {
		const result = assignSeats([p('1')], new Map([[id('1'), 'seat_T01_Y3']]), LAYOUT);
		expect(result.seated.size).toBe(0);
		expect(result.standing).toEqual([p('1')]);
		expect(result.placements.get('1')?.seat).toBeNull();
	});

	it('a room without stand points puts standing people at the camera target', () => {
		const result = assignSeats([p('1')], new Map(), {...LAYOUT, stands: []});
		expect(result.placements.get('1')?.position).toEqual({x: 0, y: 0, z: 0});
	});
});

describe('freeLoungeSeatCount', () => {
	it('counts lounge seats no attribute holds; table seats do not count', () => {
		expect(freeLoungeSeatCount(LAYOUT, new Map())).toBe(3);
		expect(
			freeLoungeSeatCount(
				LAYOUT,
				new Map([
					[id('1'), 'seat_A_01'],
					[id('2'), 'seat_T01_1'],
				]),
			),
		).toBe(2);
		expect(
			freeLoungeSeatCount(
				LAYOUT,
				new Map([
					[id('1'), 'seat_A_01'],
					[id('2'), 'seat_A_02'],
					[id('3'), 'seat_B_01'],
				]),
			),
		).toBe(0);
	});

	it('freeLoungeSeatCount ignores watch seats', () => {
		// Every lounge seat taken, the watch seat free: no lounge seat for the fallback to ask for.
		const full = new Map([
			[id('1'), 'seat_A_01'],
			[id('2'), 'seat_A_02'],
			[id('3'), 'seat_B_01'],
		]);
		expect(freeLoungeSeatCount(LAYOUT, full)).toBe(0);
		expect(freeLoungeSeatCount(LAYOUT, new Map())).toBe(3);
	});
});
