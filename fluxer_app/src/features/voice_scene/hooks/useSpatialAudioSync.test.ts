// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomLayout, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {assignSeats} from '@app/features/voice_scene/utils/SeatAssignment';
import type {Room} from 'livekit-client';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const controller = vi.hoisted(() => ({
	attach: vi.fn(),
	detach: vi.fn(),
	setMode: vi.fn(),
	update: vi.fn(),
}));
vi.mock('@app/features/voice_scene/audio/RoomSpatialAudio', () => ({createRoomSpatialAudio: vi.fn(() => controller)}));

const {createRoomSpatialAudio} = await import('@app/features/voice_scene/audio/RoomSpatialAudio');
const {useSpatialAudioSync} = await import('@app/features/voice_scene/hooks/useSpatialAudioSync');

const LAYOUT: RoomLayout = {
	seats: [
		{name: 'seat_A_01', group: 'A', position: {x: 1, y: 1, z: 0}, table: null, watch: null},
		{name: 'seat_B_01', group: 'B', position: {x: 2, y: 1, z: 0}, table: null, watch: null},
	],
	stands: [{x: 10, y: 1, z: 0}],
	tables: [],
	camTarget: {x: 0, y: 0, z: 0},
	camHome: {x: 0, y: 5, z: 8},
	camPan: {x: 0, z: 0},
	screen: {center: {x: 0, y: 2, z: -4}, width: 2, height: 1.125, normal: {x: 0, y: 0, z: 1}},
};

function fakeHandle(layout: RoomLayout = LAYOUT) {
	const listeners = new Set<() => void>();
	let azimuth = 0;
	const handle: VoiceSceneHandle = {
		layout,
		project: () => ({x: 0, y: 0, visible: true, scale: 1}),
		onViewChange: (cb) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		getCameraAzimuth: () => azimuth,
		requestRender: vi.fn(),
		setTableTop: vi.fn(),
		attachScreenElement: vi.fn(),
		screenInView: () => true,
		occluder: () => () => false,
		wheel: vi.fn(),
		getCameraMode: () => 'orbit',
		onCameraModeChange: () => () => {},
		focusScreen: vi.fn(),
		enterSeatView: vi.fn(),
		exitToOrbit: vi.fn(),
		mountTableGame: () => null,
	};
	return {
		handle,
		rotate(next: number) {
			azimuth = next;
			for (const cb of listeners) cb();
		},
	};
}

interface Entry {
	userId: string;
	connectionId: string;
	isLocal: boolean;
	hasScreenShare: boolean;
}

const entry = (userId: string, extra: Partial<Entry> = {}): Entry => ({
	userId,
	connectionId: 'c',
	isLocal: false,
	hasScreenShare: false,
	...extra,
});

const ROOM = {name: 'room'} as unknown as Room;
let root: Root;

interface ProbeProps {
	handle: VoiceSceneHandle;
	participants: ReadonlyArray<Entry>;
	seats: ReadonlyMap<string, string>;
	enabled: boolean;
	room?: Room | null;
}

function Probe({handle, participants, seats, enabled, room = ROOM}: ProbeProps): null {
	const assignment = assignSeats(participants, seats, handle.layout);
	useSpatialAudioSync({handle, room, assignment, participants, myUserId: '1', enabled});
	return null;
}

function render(props: ProbeProps): void {
	act(() => root.render(createElement(Probe, props)));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	for (const fn of Object.values(controller)) fn.mockClear();
	vi.mocked(createRoomSpatialAudio).mockClear();
	root = createRoot(document.createElement('div'));
});

afterEach(() => {
	act(() => root.unmount());
});

describe('useSpatialAudioSync', () => {
	it('feeds positions of seated and standing speakers and the TV screen to RoomSpatialAudio.update on seat or camera change', () => {
		const {handle, rotate} = fakeHandle();
		const participants = [entry('1', {isLocal: true}), entry('3'), entry('2', {hasScreenShare: true})];
		const seats = new Map([
			['user_1_c', 'seat_B_01'],
			['user_2_c', 'seat_A_01'],
		]);
		render({handle, participants, seats, enabled: true});
		expect(createRoomSpatialAudio).toHaveBeenCalledTimes(1);
		expect(controller.attach).toHaveBeenCalledWith(ROOM);
		expect(controller.update).toHaveBeenLastCalledWith({
			listener: {
				position: {x: 2, y: 1, z: 0},
				azimuth: 0,
				home: {camHome: LAYOUT.camHome, camTarget: LAYOUT.camTarget},
			},
			// Seat order first (seat_A_01 before the standing user 3), then the screen from the TV.
			speakers: [
				{identity: 'user_2_c', kind: 'mic', position: {x: 1, y: 1, z: 0}},
				{identity: 'user_3_c', kind: 'mic', position: {x: 10, y: 1, z: 0}},
				{identity: 'user_2_c', kind: 'screen', position: LAYOUT.screen!.center},
			],
		});
		const updates = controller.update.mock.calls.length;
		// User 3 sits down: the new seat reaches the audio.
		render({handle, participants, seats: new Map([...seats, ['user_3_c', 'seat_A_01']]), enabled: true});
		expect(controller.update.mock.calls.length).toBeGreaterThan(updates);
		rotate(0.4);
		expect(controller.update.mock.lastCall?.[0].listener.azimuth).toBe(0.4);
	});

	it('a camera change without rotation does not touch the audio', () => {
		const {handle, rotate} = fakeHandle();
		render({handle, participants: [entry('1', {isLocal: true}), entry('2')], seats: new Map(), enabled: true});
		const updates = controller.update.mock.calls.length;
		rotate(0); // zoom only
		expect(controller.update.mock.calls.length).toBe(updates);
	});

	it('my other device counts as a speaker at my place; this connection does not', () => {
		const {handle} = fakeHandle();
		render({
			handle,
			participants: [entry('1', {isLocal: true}), entry('1', {connectionId: 'phone'})],
			seats: new Map([['user_1_c', 'seat_A_01']]),
			enabled: true,
		});
		expect(controller.update.mock.lastCall?.[0].speakers).toEqual([
			{identity: 'user_1_phone', kind: 'mic', position: {x: 1, y: 1, z: 0}},
		]);
	});

	it('spatial toggle off → setMode(flat)', () => {
		const {handle} = fakeHandle();
		render({handle, participants: [], seats: new Map(), enabled: true});
		expect(controller.setMode).toHaveBeenLastCalledWith('spatial');
		render({handle, participants: [], seats: new Map(), enabled: false});
		expect(controller.setMode).toHaveBeenLastCalledWith('flat');
	});

	it('unmount → detach', () => {
		const {handle} = fakeHandle();
		render({handle, participants: [], seats: new Map(), enabled: true});
		expect(controller.detach).not.toHaveBeenCalled();
		act(() => root.unmount());
		root = createRoot(document.createElement('div'));
		expect(controller.detach).toHaveBeenCalledTimes(1);
	});

	it('leaving the call (no room) detaches', () => {
		const {handle} = fakeHandle();
		render({handle, participants: [], seats: new Map(), enabled: true});
		render({handle, participants: [], seats: new Map(), enabled: true, room: null});
		expect(controller.detach).toHaveBeenCalledTimes(1);
	});
});
