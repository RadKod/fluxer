// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {RoomLayout, Vec3, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {act, createElement, useEffect} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type Quality = 'low' | 'medium' | 'high';

const env = vi.hoisted(() => ({
	cameras: true,
	showRoomCameras: true,
	scale: 1,
	mode: 'orbit',
	callPopout: false,
	tilePopouts: new Set<string>(),
	sent: new Map<string, 'low' | 'medium' | 'high'>(),
	// Cameras subscribed straight through LiveKit, outside the managed path (upstream setLocalVideoDisabled(false)).
	direct: new Set<string>(),
}));

vi.mock('@app/features/auth/state/Authentication', () => ({default: {currentUserId: '1'}}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: true, games: true, cameras: env.cameras}),
}));
vi.mock('@app/features/voice_scene/state/VoiceSceneSettings', () => ({
	default: {
		get showRoomCameras() {
			return env.showRoomCameras;
		},
	},
}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({default: {connectionId: 'conn-1'}}));
vi.mock('@app/features/voice/state/PopoutWindowManager', () => ({
	getVoiceTilePopoutKey: (identity: string, source: string) => `tile:${source}:${identity}`,
	default: {
		isOpen: (key: string) => env.tilePopouts.has(key),
		isCallPopoutOpenForChannel: () => env.callPopout,
	},
}));
// The managed path in miniature: what the voice server sends this viewer (VideoSubscriptionManager keeps the quality
// of an existing entry on subscribe).
vi.mock('@app/features/voice_scene/video/RoomCameraStore', async () => {
	const {RoomCameraSubscriptions} = await import('@app/features/voice_scene/video/RoomCameraSubscriptions');
	return {
		default: new RoomCameraSubscriptions({
			subscribeToVideo: (identity: string, _element: unknown, quality: Quality) => {
				if (!env.sent.has(identity)) env.sent.set(identity, quality);
			},
			setVideoQuality: (identity: string, quality: Quality) => {
				if (env.sent.has(identity)) env.sent.set(identity, quality);
			},
			unsubscribeFromVideo: (identity: string) => env.sent.delete(identity),
		}),
	};
});

const {default: CallMediaPrefs} = await import('@app/features/voice/state/CallMediaPrefs');
const {Logger} = await import('@app/features/platform/utils/AppLogger');
const {assignSeats} = await import('@app/features/voice_scene/utils/SeatAssignment');
const {useRoomCameras} = await import('@app/features/voice_scene/video/useRoomCameras');
const {observer} = await import('mobx-react-lite');

const seat = (name: string, x: number, z: number, table: {slot: string; position: 1 | 2 | 3 | 4} | null = null) => ({
	name,
	group: table?.slot ?? 'A',
	position: {x, y: 1, z},
	table,
	watch: null,
});

const LAYOUT: RoomLayout = {
	seats: [
		seat('seat_T01_1', 0, 1, {slot: 'T01', position: 1}),
		seat('seat_T01_3', 0, -1, {slot: 'T01', position: 3}),
		seat('seat_A_01', 3, 0),
		seat('seat_A_02', 8, 0),
		// Behind the camera in these tests.
		seat('seat_A_03', 2, 99),
	],
	stands: [{x: 5, y: 1, z: 3}],
	tables: [{slot: 'T01', center: {x: 0, y: 0.8, z: 0}, topSize: 1.3}],
	camTarget: {x: 0, y: 0, z: 0},
	camHome: {x: 0, y: 5, z: 8},
	screen: null,
	camPan: {x: 0, z: 0},
};

const identity = (userId: string) => `user_${userId}_conn-${userId}`;

function entry(userId: string, hasCamera = true) {
	return {
		user: {id: userId} as never,
		userId,
		connectionId: `conn-${userId}`,
		speaking: false,
		hasCamera,
		hasScreenShare: false,
		isLocal: userId === '1',
		selfMute: false,
		selfDeaf: false,
	};
}

// Me at the table, a table mate, two lounge seats (one behind the camera), one standing, one without a camera.
const SEATS: Record<string, string> = {
	'1': 'seat_T01_1',
	'2': 'seat_T01_3',
	'3': 'seat_A_01',
	'4': 'seat_A_02',
	'5': 'seat_A_03',
};
const ENTRIES = ['1', '2', '3', '4', '5', '6', '7'].map((userId) => entry(userId, userId !== '7'));

function fakeHandle() {
	const listeners = new Set<() => void>();
	const handle = {
		layout: LAYOUT,
		project: (p: Vec3) => ({x: p.x * 100, y: p.y * 100, visible: p.z < 50, scale: env.scale}),
		onViewChange: (cb: () => void) => {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		getCameraMode: () => env.mode,
	} as unknown as VoiceSceneHandle;
	return {handle, viewChanged: () => listeners.forEach((cb) => cb())};
}

// What LiveKit reports subscribed: the managed path's set plus anything subscribed around it.
const ROOM = {
	get remoteParticipants() {
		return new Map(
			['2', '3', '4', '5', '6'].map((userId) => {
				const id = identity(userId);
				const camera = {
					get isSubscribed() {
						return env.sent.has(id) || env.direct.has(id);
					},
				};
				return [
					id,
					{identity: id, getTrackPublication: (source: string) => (source === 'camera' ? camera : undefined)},
				];
			}),
		);
	},
} as never;

type Props = {tv?: string | null; entries?: typeof ENTRIES; handle: VoiceSceneHandle};

const RoomCameras = observer(function RoomCameras({tv = null, entries = ENTRIES, handle}: Props) {
	const seatOf = new Map(Object.entries(SEATS).map(([userId, name]) => [identity(userId), name]));
	const assignment = assignSeats(entries, seatOf, LAYOUT);
	useRoomCameras({
		handle,
		room: ROOM,
		channelId: '500',
		assignment,
		entries,
		avatarPoints: new Map(LAYOUT.seats.map((item) => [item.name, item.position])),
		tv,
	});
	return null;
});

// The flat grid's tiles (useAutoVideoSubscription in miniature): every camera they show, at the top layer, taken outside
// the room's owner on mount and dropped on unmount.
const GRID_TILES = ['2', '3', '4', '5', '6'].map(identity);
function GridTiles() {
	useEffect(() => {
		for (const tile of GRID_TILES) env.sent.set(tile, 'high');
		return () => {
			for (const tile of GRID_TILES) env.sent.delete(tile);
		};
	}, []);
	return null;
}

let root: Root;
let host: HTMLDivElement;

function render(element: ReturnType<typeof createElement>): void {
	act(() => root.render(element));
}

beforeEach(() => {
	vi.useFakeTimers();
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	Object.assign(env, {
		cameras: true,
		showRoomCameras: true,
		scale: 1,
		mode: 'orbit',
		callPopout: false,
		tilePopouts: new Set(),
	});
	env.sent.clear();
	env.direct.clear();
	CallMediaPrefs.clearForCall('conn-1');
	window.devicePixelRatio = 1;
	host = document.createElement('div');
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	vi.useRealTimers();
});

describe('useRoomCameras', () => {
	it('a seated table mate docked from outside the view stays subscribed at medium while lounge cameras stay unchanged', () => {
		env.mode = 'seat';
		const {handle} = fakeHandle();
		const project = handle.project;
		handle.project = (point) => (point.z === -1 ? {...project(point), x: -200, visible: false} : project(point));
		render(createElement(RoomCameras, {handle}));
		expect(env.sent.get(identity('2'))).toBe('medium');
		expect(env.sent.get(identity('3'))).toBe('low');
		expect(env.sent.has(identity('5'))).toBe(false);
	});

	it('subscribes the drawn cameras on screen, my table first; never mine, never off-screen discs', () => {
		const {handle} = fakeHandle();
		render(createElement(RoomCameras, {handle}));
		expect([...env.sent.keys()]).toEqual([identity('2'), identity('3'), identity('6'), identity('4')]);
		expect([...env.sent.values()].every((quality) => quality === 'low')).toBe(true);
	});

	it('discs of at least 96 device pixels get medium', () => {
		const {handle} = fakeHandle();
		// Lounge avatar 40 css px × the anchor's 1.8 cap × 1.5 = 108 device px; table avatar 32 × 1.8 × 1.5 = 86.
		env.scale = 2;
		window.devicePixelRatio = 1.5;
		render(createElement(RoomCameras, {handle}));
		expect(env.sent.get(identity('3'))).toBe('medium');
		expect(env.sent.get(identity('2'))).toBe('low');
	});

	it('a disc under 24 device pixels keeps the picture; screen-sized table cards remain visible', () => {
		const {handle} = fakeHandle();
		// 32 × the anchor's 0.6 floor = 19 px.
		env.scale = 0.1;
		render(createElement(RoomCameras, {handle}));
		expect([...env.sent.keys()]).toEqual([identity('2'), identity('3'), identity('4')]);
	});

	it('the TV camera is the one high subscription', () => {
		const {handle} = fakeHandle();
		render(createElement(RoomCameras, {handle, tv: identity('5')}));
		expect(env.sent.get(identity('5'))).toBe('high');
	});

	it('switch off or setting off → nothing; turning it off releases what the room held', () => {
		const {handle} = fakeHandle();
		env.cameras = false;
		render(createElement(RoomCameras, {handle}));
		expect(env.sent.size).toBe(0);
		env.cameras = true;
		render(createElement(RoomCameras, {handle, entries: [...ENTRIES]}));
		act(() => vi.advanceTimersByTime(500));
		expect(env.sent.size).toBe(4);
		env.showRoomCameras = false;
		render(createElement(RoomCameras, {handle, entries: [...ENTRIES]}));
		act(() => vi.advanceTimersByTime(500 + 2000));
		expect(env.sent.size).toBe(0);
	});

	it('a locally disabled camera is dropped (M7)', () => {
		const {handle} = fakeHandle();
		render(createElement(RoomCameras, {handle}));
		// CallMediaPrefs drops the very first write of a call (`ensure` mutates the plain object it just assigned, not the
		// observable copy MobX stores); the context menu meets the call's scope already created.
		act(() => CallMediaPrefs.setVideoDisabled('conn-1', identity('3'), false));
		act(() => CallMediaPrefs.setVideoDisabled('conn-1', identity('3'), true));
		// The next plan (≤ 500 ms), then the 2 s grace.
		act(() => vi.advanceTimersByTime(2500));
		expect(env.sent.has(identity('3'))).toBe(false);
	});

	it('popout-held camera never touched by the room', () => {
		const {handle} = fakeHandle();
		render(createElement(RoomCameras, {handle}));
		env.tilePopouts.add(`tile:camera:${identity('3')}`);
		render(createElement(RoomCameras, {handle, entries: [...ENTRIES]}));
		act(() => vi.advanceTimersByTime(5000));
		act(() => root.unmount());
		// The popout's tile keeps the subscription the room handed over.
		expect(env.sent.has(identity('3'))).toBe(true);
		root = createRoot(host);
	});

	it('view changes re-plan at most every 500 ms', () => {
		const {handle, viewChanged} = fakeHandle();
		render(createElement(RoomCameras, {handle}));
		expect(env.sent.has(identity('5'))).toBe(false);
		act(() => vi.advanceTimersByTime(600));
		// The view turns: the lounge seat behind comes into view…
		const project = handle.project;
		(handle as {project: VoiceSceneHandle['project']}).project = (p) => ({...project(p), visible: true});
		act(() => viewChanged());
		expect(env.sent.has(identity('5'))).toBe(true);
		// …and out again at once: held until the throttle lets the next plan run, then the 2 s grace.
		(handle as {project: VoiceSceneHandle['project']}).project = project;
		act(() => viewChanged());
		act(() => viewChanged());
		act(() => vi.advanceTimersByTime(499));
		expect(env.sent.has(identity('5'))).toBe(true);
		act(() => vi.advanceTimersByTime(1 + 2000));
		expect(env.sent.has(identity('5'))).toBe(false);
	});

	it('a camera subscribed outside the room plan logs one warning per session (GEÇİCİ trigger, O1 c)', () => {
		const warn = vi.spyOn(Logger.prototype, 'warn');
		const offPlan = () => warn.mock.calls.filter(([message]) => String(message).includes('outside the room plan'));
		const {handle} = fakeHandle();
		render(createElement(RoomCameras, {handle}));
		// Grace and downgrade holds are the room's own: nothing to report.
		env.scale = 0.1;
		render(createElement(RoomCameras, {handle, entries: [...ENTRIES]}));
		act(() => vi.advanceTimersByTime(1000));
		expect(offPlan()).toHaveLength(0);
		// Upstream "show video" again subscribes camera 5 (behind the camera, not planned) straight through LiveKit.
		env.direct.add(identity('5'));
		act(() => vi.advanceTimersByTime(2000));
		expect(offPlan()).toHaveLength(1);
		expect(offPlan()[0]![1]).toMatchObject({count: 1});
		env.direct.add(identity('6'));
		act(() => vi.advanceTimersByTime(10_000));
		expect(offPlan()).toHaveLength(1);
		warn.mockRestore();
	});

	it('room → grid → room leaves exactly the capped set subscribed (M6, one React tree)', () => {
		const {handle} = fakeHandle();
		render(createElement(RoomCameras, {handle}));
		const roomSet = new Map(env.sent);
		// One commit: the room's cleanup runs before the grid's effects.
		render(createElement(GridTiles));
		expect([...env.sent.values()].every((quality) => quality === 'high')).toBe(true);
		expect(env.sent.size).toBe(5);
		act(() => vi.advanceTimersByTime(5000));
		expect(env.sent.size).toBe(5);
		render(createElement(RoomCameras, {handle}));
		expect(env.sent).toEqual(roomSet);
		act(() => vi.advanceTimersByTime(5000));
		expect(env.sent).toEqual(roomSet);
	});
});
