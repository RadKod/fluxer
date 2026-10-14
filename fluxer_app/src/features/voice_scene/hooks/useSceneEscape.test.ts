// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SceneCameraMode, VoiceSceneHandle} from '@app/features/voice_scene/scene/VoiceSceneTypes';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {useSceneEscape} = await import('@app/features/voice_scene/hooks/useSceneEscape');

let mode: SceneCameraMode = 'orbit';
const handle = {getCameraMode: () => mode, exitToOrbit: vi.fn()} as unknown as VoiceSceneHandle & {
	exitToOrbit: ReturnType<typeof vi.fn>;
};

function Probe(): null {
	useSceneEscape(handle);
	return null;
}

let root: Root;

function press(key: string, target: EventTarget = document.body): KeyboardEvent {
	const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true});
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	handle.exitToOrbit.mockClear();
	root = createRoot(document.createElement('div'));
	act(() => root.render(createElement(Probe)));
});

afterEach(() => {
	act(() => root.unmount());
	document.body.replaceChildren();
});

describe('useSceneEscape', () => {
	it('Esc in focus or seat calls exitToOrbit; Esc elsewhere does nothing', () => {
		mode = 'focus';
		press('Escape');
		mode = 'seat';
		press('Escape');
		expect(handle.exitToOrbit).toHaveBeenCalledTimes(2);
		mode = 'orbit';
		press('Escape');
		mode = 'seat';
		press('Enter');
		expect(handle.exitToOrbit).toHaveBeenCalledTimes(2);
	});

	it('Esc while typing or inside a dialog is theirs, not the room camera', () => {
		mode = 'seat';
		const input = document.body.appendChild(document.createElement('textarea'));
		press('Escape', input);
		const dialog = document.body.appendChild(document.createElement('div'));
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		press('Escape', dialog.appendChild(document.createElement('button')));
		expect(handle.exitToOrbit).not.toHaveBeenCalled();
	});

	it('unmount stops listening', () => {
		mode = 'seat';
		act(() => root.unmount());
		root = createRoot(document.createElement('div'));
		press('Escape');
		expect(handle.exitToOrbit).not.toHaveBeenCalled();
	});
});
