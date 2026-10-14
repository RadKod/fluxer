// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	RoomLayout,
	SceneCameraMode,
	SeatViewTarget,
	VoiceSceneHandle,
} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import type {TableGameSummary} from '@fluxer/schema/src/domains/table_game/TableGameSchemas';
import {observer} from 'mobx-react-lite';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/table_game/state/TableGames', async () => {
	const {observable} = await import('mobx');
	const summaries = observable.map<string, TableGameSummary>({}, {deep: false});
	return {default: {getSummary: (_channelId: string, slot: string) => summaries.get(slot) ?? null}, summaries};
});

vi.mock('@app/features/ui/commands/PopoutCommands', () => ({close: vi.fn()}));

const PopoutCommands = await import('@app/features/ui/commands/PopoutCommands');
const {summaries} = (await import('@app/features/table_game/state/TableGames')) as unknown as {
	summaries: Map<string, TableGameSummary>;
};
const {default: VoiceSceneSeatView} = await import('@app/features/voice_scene/state/VoiceSceneSeatView');
const {useSeatView} = await import('@app/features/voice_scene/hooks/useSeatView');

const LAYOUT: RoomLayout = {
	seats: [
		{name: 'seat_A_01', group: 'A', position: {x: 1, y: 1, z: 0}, table: null, watch: null},
		{name: 'seat_T01_1', group: 'T01', position: {x: 4, y: 1, z: 1}, table: {slot: 'T01', position: 1}, watch: null},
		{name: 'seat_T01_Y1', group: 'T01', position: {x: 4, y: 1, z: 2}, table: null, watch: {slot: 'T01', index: 1}},
	],
	stands: [],
	tables: [{slot: 'T01', center: {x: 4, y: 0.8, z: 0}, topSize: 1.3}],
	camTarget: {x: 0, y: 0, z: 0},
	camHome: {x: 0, y: 5, z: 8},
	screen: null,
	camPan: {x: 0, z: 0},
};

function fakeHandle() {
	let mode: SceneCameraMode = 'orbit';
	const modeListeners = new Set<(mode: SceneCameraMode) => void>();
	const setMode = (next: SceneCameraMode) => {
		if (next === mode) return;
		mode = next;
		for (const listener of modeListeners) listener(next);
	};
	const handle = {
		layout: LAYOUT,
		getCameraMode: () => mode,
		onCameraModeChange: (listener: (mode: SceneCameraMode) => void) => {
			modeListeners.add(listener);
			return () => modeListeners.delete(listener);
		},
		enterSeatView: vi.fn((_target: SeatViewTarget) => setMode('seat')),
		exitToOrbit: vi.fn(() => setMode('orbit')),
	};
	return handle as typeof handle & VoiceSceneHandle;
}

type Observed = (entries: Array<{contentRect: {width: number; height: number}}>) => void;
let resizeCallbacks: Array<Observed> = [];
class FakeResizeObserver {
	constructor(callback: Observed) {
		resizeCallbacks.push(callback);
	}
	observe() {}
	disconnect() {
		resizeCallbacks = [];
	}
}

const summary = (game: TableGameSummary['game']): TableGameSummary => ({
	slot: 'T01',
	game,
	speed: 'normal',
	status: 'lobby',
	players: [],
	spectator_count: 0,
	version: 1,
	result: null,
});

let root: Root;
let latest: SeatViewTarget | null = null;
const container = Object.assign(document.createElement('div'), {});

const Probe = observer(function Probe(props: {handle: VoiceSceneHandle; seatName: string | null; available: boolean}) {
	latest = useSeatView({...props, channelId: '500', container});
	return null;
});

function render(handle: VoiceSceneHandle, seatName: string | null, available = true): void {
	act(() => root.render(createElement(Probe, {handle, seatName, available})));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
	Object.defineProperty(container, 'clientWidth', {value: 1280, configurable: true});
	Object.defineProperty(container, 'clientHeight', {value: 720, configurable: true});
	resizeCallbacks = [];
	vi.mocked(PopoutCommands.close).mockClear();
	act(() => {
		summaries.clear();
		VoiceSceneSeatView.setSeat(null);
	});
	root = createRoot(document.createElement('div'));
	latest = null;
});

afterEach(() => {
	act(() => root.unmount());
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('useSeatView', () => {
	it('sitting at a table seat enters the seat view once', () => {
		const handle = fakeHandle();
		render(handle, 'seat_T01_1');
		render(handle, 'seat_T01_1');
		expect(handle.enterSeatView).toHaveBeenCalledTimes(1);
		expect(handle.enterSeatView.mock.calls[0]![0]).toMatchObject({slot: 'T01', role: 'player', game: null});
		expect(handle.enterSeatView.mock.calls[0]![0].seat.name).toBe('seat_T01_1');
		expect(latest?.role).toBe('player');
		expect(VoiceSceneSeatView.seat).toEqual({channelId: '500', slot: 'T01', seat: 'seat_T01_1'});
	});

	it('sitting at a watch seat enters it read-only', () => {
		const handle = fakeHandle();
		render(handle, 'seat_T01_Y1');
		expect(handle.enterSeatView).toHaveBeenCalledTimes(1);
		expect(handle.enterSeatView.mock.calls[0]![0]).toMatchObject({slot: 'T01', role: 'watch'});
	});

	it('a lounge seat or standing never enters', () => {
		const handle = fakeHandle();
		render(handle, 'seat_A_01');
		render(handle, null);
		expect(handle.enterSeatView).not.toHaveBeenCalled();
		expect(VoiceSceneSeatView.seat).toBeNull();
	});

	it("Odaya dön exits but keeps the seat; table label 'Masaya dön' re-enters", () => {
		const handle = fakeHandle();
		render(handle, 'seat_T01_1');
		// Any way out of the seat view (button, Esc, wheel) is the camera leaving 'seat'.
		act(() => handle.exitToOrbit());
		expect(latest).toBeNull();
		expect(VoiceSceneSeatView.seat?.seat).toBe('seat_T01_1');
		expect(VoiceSceneSeatView.dismissed).toBe(true);
		render(handle, 'seat_T01_1');
		expect(handle.enterSeatView).toHaveBeenCalledTimes(1);
		act(() => VoiceSceneSeatView.returnToTable());
		expect(handle.enterSeatView).toHaveBeenCalledTimes(2);
		expect(latest?.slot).toBe('T01');
	});

	it('mobile / no WebGL never enters', () => {
		const handle = fakeHandle();
		render(handle, 'seat_T01_1', false);
		expect(handle.enterSeatView).not.toHaveBeenCalled();
		expect(latest).toBeNull();
		expect(VoiceSceneSeatView.seat).toBeNull();
	});

	it('leaving the seat returns to orbit', () => {
		const handle = fakeHandle();
		render(handle, 'seat_T01_1');
		render(handle, 'seat_A_01');
		expect(handle.exitToOrbit).toHaveBeenCalledTimes(1);
		expect(handle.getCameraMode()).toBe('orbit');
		expect(VoiceSceneSeatView.seat).toBeNull();
		expect(VoiceSceneSeatView.dismissed).toBe(false);
	});

	it('a game set up at my table re-enters with its pose', () => {
		const handle = fakeHandle();
		render(handle, 'seat_T01_1');
		act(() => summaries.set('T01', summary('okey')));
		expect(handle.enterSeatView).toHaveBeenCalledTimes(2);
		expect(handle.enterSeatView.mock.calls[1]![0].game).toBe('okey');
	});

	it('a resize in the seat view re-enters with the new aspect after it settles', () => {
		vi.useFakeTimers();
		const handle = fakeHandle();
		render(handle, 'seat_T01_1');
		expect(resizeCallbacks).toHaveLength(1);
		// The observer's first report is the size it already had: nothing to redo.
		act(() => resizeCallbacks[0]!([{contentRect: {width: 1280, height: 720}}]));
		act(() => vi.advanceTimersByTime(1000));
		expect(handle.enterSeatView).toHaveBeenCalledTimes(1);
		act(() => {
			resizeCallbacks[0]!([{contentRect: {width: 900, height: 720}}]);
			resizeCallbacks[0]!([{contentRect: {width: 800, height: 720}}]);
		});
		act(() => vi.advanceTimersByTime(1000));
		expect(handle.enterSeatView).toHaveBeenCalledTimes(2);
		expect(handle.enterSeatView.mock.calls[1]![0].seat.name).toBe('seat_T01_1');
	});

	it("starting the seat view closes that table's open panel; a later re-pose leaves it (spec 3)", () => {
		const handle = fakeHandle();
		render(handle, 'seat_T01_1');
		expect(PopoutCommands.close).toHaveBeenCalledTimes(1);
		expect(PopoutCommands.close).toHaveBeenCalledWith('table-game-500-T01');
		// A game set up from the panel while seated re-poses the camera; the panel the player opened stays.
		act(() => summaries.set('T01', summary('chess')));
		expect(handle.enterSeatView).toHaveBeenCalledTimes(2);
		expect(PopoutCommands.close).toHaveBeenCalledTimes(1);
	});

	it('unknown game kind at my table / watch seat never throws and stays in the room view', () => {
		// a newer build set this table up with a kind this one has no seats or pose for.
		const unknown = summary('future_game' as TableGameSummary['game']);
		const handle = fakeHandle();
		act(() => summaries.set('T01', unknown));
		render(handle, 'seat_T01_1');
		render(handle, 'seat_T01_Y1');
		expect(handle.enterSeatView).not.toHaveBeenCalled();
		expect(latest).toBeNull();
		expect(VoiceSceneSeatView.seat).toBeNull();
		// A known game in the seat view that turns into an unknown one goes back to the room.
		act(() => summaries.set('T01', summary('chess')));
		expect(handle.enterSeatView).toHaveBeenCalledTimes(1);
		act(() => summaries.set('T01', unknown));
		expect(handle.enterSeatView).toHaveBeenCalledTimes(1);
		expect(handle.exitToOrbit).toHaveBeenCalledTimes(1);
		expect(latest).toBeNull();
	});

	it('no resize watch outside the seat view', () => {
		const handle = fakeHandle();
		render(handle, 'seat_A_01');
		expect(resizeCallbacks).toHaveLength(0);
	});
});
