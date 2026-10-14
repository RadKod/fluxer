// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type CameraCandidate,
	planRoomCameras,
	ROOM_CAMERA_HIGH_MAX,
	ROOM_CAMERA_MAX,
	ROOM_CAMERA_MEDIUM_MAX,
} from '@app/features/voice_scene/video/CameraSubscriptionPlan';
import {describe, expect, it} from 'vitest';

function candidate(identity: string, overrides: Partial<CameraCandidate> = {}): CameraCandidate {
	return {
		identity,
		visible: true,
		discPx: 48,
		distanceM: 3,
		sameTable: false,
		speakingRecently: false,
		seatOrder: 0,
		locallyDisabled: false,
		externallyHeld: false,
		...overrides,
	};
}

function count(plan: ReadonlyMap<string, string>, quality: string): number {
	return [...plan.values()].filter((value) => value === quality).length;
}

describe('planRoomCameras', () => {
	it('table cards request medium seated and low in the room even on a dense display; caps and TV still apply', () => {
		const candidates = Array.from({length: 12}, (_, i) =>
			candidate(`p${i}`, {
				discPx: 250,
				distanceM: i,
				cameraCard: i < 6 ? 'seat' : 'room',
			}),
		);
		const plan = planRoomCameras({enabled: true, candidates, tv: 'p11'});
		expect(plan.size).toBe(9);
		expect(count(plan, 'medium')).toBe(4);
		expect(plan.get('p6')).toBe('low');
		expect(plan.get('p11')).toBe('high');
		const room = planRoomCameras({
			enabled: true,
			candidates: candidates.map((c) => ({...c, cameraCard: 'room' as const})),
			tv: null,
		});
		expect(count(room, 'medium')).toBe(0);
	});
	it('never more than 9 camera subscriptions, at most 4 medium, none high outside the TV', () => {
		// A crowded room: 30 cameras, every disc big enough for medium, some at the same table.
		const candidates = Array.from({length: 30}, (_, i) =>
			candidate(`p${i}`, {discPx: 120, distanceM: 1 + i, sameTable: i % 7 === 0, seatOrder: i}),
		);
		for (const tv of [null, 'p29']) {
			const plan = planRoomCameras({enabled: true, candidates, tv});
			expect(plan.size).toBe(ROOM_CAMERA_MAX);
			expect(count(plan, 'medium')).toBe(ROOM_CAMERA_MEDIUM_MAX);
			expect(count(plan, 'high')).toBe(tv ? ROOM_CAMERA_HIGH_MAX : 0);
			for (const [identity, quality] of plan) if (quality === 'high') expect(identity).toBe(tv);
		}
	});

	it('TV camera is the only high and counts', () => {
		const candidates = Array.from({length: 12}, (_, i) => candidate(`p${i}`, {distanceM: 1 + i, seatOrder: i}));
		// The TV person sits far away and their disc is off screen: the TV still plays them.
		candidates.push(candidate('tv', {visible: false, discPx: 0, distanceM: 50}));
		const plan = planRoomCameras({enabled: true, candidates, tv: 'tv'});
		expect(plan.get('tv')).toBe('high');
		expect(plan.size).toBe(ROOM_CAMERA_MAX);
		expect([...plan.keys()].filter((identity) => identity !== 'tv')).toEqual([
			'p0',
			'p1',
			'p2',
			'p3',
			'p4',
			'p5',
			'p6',
			'p7',
		]);
	});

	it('same table first, then nearest', () => {
		const candidates = [
			candidate('near', {distanceM: 1}),
			candidate('mate-far', {distanceM: 2.4, sameTable: true}),
			candidate('mate-near', {distanceM: 1.6, sameTable: true}),
			candidate('mid', {distanceM: 4}),
			// Equal distance: the one who spoke in the last 10 s wins, then the seat order.
			candidate('quiet', {distanceM: 6, seatOrder: 1}),
			candidate('quiet-first', {distanceM: 6, seatOrder: 0}),
			candidate('talker', {distanceM: 6, seatOrder: 5, speakingRecently: true}),
		];
		const order = [...planRoomCameras({enabled: true, candidates, tv: null}).keys()];
		expect(order).toEqual(['mate-near', 'mate-far', 'near', 'mid', 'talker', 'quiet-first', 'quiet']);
	});

	it('medium only for the first four discs of at least 96 px; the rest low', () => {
		const candidates = [
			candidate('small-mate', {sameTable: true, distanceM: 1, discPx: 60}),
			...Array.from({length: 6}, (_, i) => candidate(`big${i}`, {distanceM: 2 + i, discPx: 96})),
		];
		const plan = planRoomCameras({enabled: true, candidates, tv: null});
		expect(plan.get('small-mate')).toBe('low');
		expect(['big0', 'big1', 'big2', 'big3'].map((identity) => plan.get(identity))).toEqual([
			'medium',
			'medium',
			'medium',
			'medium',
		]);
		expect(plan.get('big4')).toBe('low');
		expect(plan.get('big5')).toBe('low');
	});

	it('discs < 24 px get the picture', () => {
		const plan = planRoomCameras({
			enabled: true,
			candidates: [
				candidate('tiny', {discPx: 23}),
				candidate('edge', {discPx: 24}),
				candidate('hidden', {visible: false}),
			],
			tv: null,
		});
		expect([...plan.keys()]).toEqual(['edge']);
	});

	it('locally disabled → none', () => {
		const candidates = [
			candidate('off', {locallyDisabled: true}),
			candidate('on'),
			candidate('tv-off', {locallyDisabled: true}),
		];
		const plan = planRoomCameras({enabled: true, candidates, tv: 'tv-off'});
		expect([...plan.keys()]).toEqual(['on']);
	});

	it('switch off or user setting off → empty plan', () => {
		const candidates = [candidate('a', {sameTable: true, discPx: 200}), candidate('tv')];
		expect(planRoomCameras({enabled: false, candidates, tv: 'tv'}).size).toBe(0);
	});

	it('popout-held camera never touched by the room: not planned, not counted', () => {
		const candidates = [
			candidate('held', {sameTable: true, discPx: 200, externallyHeld: true}),
			candidate('tv-held', {externallyHeld: true}),
			...Array.from({length: 12}, (_, i) => candidate(`p${i}`, {distanceM: 1 + i, seatOrder: i})),
		];
		const plan = planRoomCameras({enabled: true, candidates, tv: 'tv-held'});
		expect(plan.has('held')).toBe(false);
		expect(plan.has('tv-held')).toBe(false);
		expect(plan.size).toBe(ROOM_CAMERA_MAX);
	});

	it('a TV person who turned the camera off is not planned', () => {
		expect(planRoomCameras({enabled: true, candidates: [candidate('a')], tv: 'gone'}).has('gone')).toBe(false);
	});
});
