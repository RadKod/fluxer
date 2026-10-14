// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SceneCameraMode, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {act, createElement, type ReactNode} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const env = vi.hoisted(() => ({cameras: true}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({useLingui: () => ({i18n: {_: (d: {message: string}) => d.message}})}));
vi.mock('@app/features/ui/tooltip/Tooltip', () => ({Tooltip: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/ui/focus_ring/FocusRing', () => ({default: ({children}: {children: ReactNode}) => children}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {response: {}}}));
vi.mock('@fluxer/schema/src/domains/experiment/ExperimentSchemas', () => ({
	readVoiceRoomAssignment: () => ({rooms: true, games: true, cameras: env.cameras}),
}));
vi.mock('@app/features/voice_scene/state/VoiceSceneSettings', async () => {
	const {makeAutoObservable} = await import('mobx');
	const settings = makeAutoObservable({
		spatialAudio: true,
		showRoomCameras: true,
		setSpatialAudio(value: boolean) {
			settings.spatialAudio = value;
		},
		setShowRoomCameras(value: boolean) {
			settings.showRoomCameras = value;
		},
	});
	return {default: settings};
});

const {default: VoiceSceneSettings} = await import('@app/features/voice_scene/state/VoiceSceneSettings');
const {VoiceSceneToolbar} = await import('@app/features/voice_scene/components/VoiceSceneToolbar');

function fakeHandle() {
	let mode: SceneCameraMode = 'orbit';
	const listeners = new Set<(mode: SceneCameraMode) => void>();
	const handle = {
		getCameraMode: () => mode,
		onCameraModeChange: (listener: (mode: SceneCameraMode) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		exitToOrbit: vi.fn(() => setMode('orbit')),
	};
	function setMode(next: SceneCameraMode): void {
		mode = next;
		for (const listener of listeners) listener(next);
	}
	return {handle: handle as typeof handle & VoiceSceneHandle, setMode};
}

let root: Root;
let host: HTMLDivElement;
const button = (text: string) =>
	[...host.querySelectorAll('button')].find((entry) => entry.textContent === text) as HTMLButtonElement | undefined;

function render(handle: VoiceSceneHandle | null): void {
	act(() => root.render(createElement(VoiceSceneToolbar, {handle})));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	env.cameras = true;
	act(() => VoiceSceneSettings.setShowRoomCameras(true));
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe('VoiceSceneToolbar', () => {
	it('TV focus shows Back; it returns to the room', () => {
		const {handle, setMode} = fakeHandle();
		render(handle);
		expect(button('Back')).toBeUndefined();
		act(() => setMode('focus'));
		act(() => button('Back')?.click());
		expect(handle.exitToOrbit).toHaveBeenCalledTimes(1);
		expect(button('Back')).toBeUndefined();
	});

	it('the seat view keeps its own way out (the seat HUD), not a second one here', () => {
		const {handle, setMode} = fakeHandle();
		render(handle);
		act(() => setMode('seat'));
		expect(button('Back')).toBeUndefined();
	});

	it('"Show cameras in the room" switch flips the setting', () => {
		render(null);
		const toggle = button('Cameras');
		expect(toggle?.getAttribute('aria-pressed')).toBe('true');
		act(() => toggle?.click());
		expect(VoiceSceneSettings.showRoomCameras).toBe(false);
		expect(button('Cameras')?.getAttribute('aria-pressed')).toBe('false');
	});

	it('no camera switch while room cameras are switched off for everyone', () => {
		env.cameras = false;
		render(null);
		expect(button('Cameras')).toBeUndefined();
		expect(button('3D audio')).toBeDefined();
	});
});
