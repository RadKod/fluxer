// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const fullscreen = vi.hoisted(() => ({element: null as Element | null}));
const persistence = vi.hoisted(() => ({makePersistent: vi.fn()}));

vi.mock('@app/features/platform/utils/FullscreenMediaUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/platform/utils/FullscreenMediaUtils')>()),
	getFullscreenElement: () => fullscreen.element,
}));
vi.mock('@app/features/platform/utils/MobXPersistence', () => persistence);

const {default: VoiceCallLayout} = await import('@app/features/voice/state/VoiceCallLayout');
const {default: VoiceSceneTvRequest, useVoiceSceneTvFullscreen} = await import(
	'@app/features/voice_scene/state/VoiceSceneTvRequest'
);
const {observer} = await import('mobx-react-lite');

const CAMERA = {kind: 'camera', identity: 'user_7_conn-7'} as const;
const SCREEN = {kind: 'screen', identity: 'user_8_conn-8'} as const;

type BridgeProps = {active: boolean; isFullscreen: boolean; enterFullscreen: () => Promise<void>};

let root: Root;
let host: HTMLDivElement;
let shown: Array<'room' | 'flat'> = [];

// VoiceCallView in miniature: the room shows unless a TV fullscreen request holds the flat view.
const CallView = observer(function CallView(props: BridgeProps) {
	const tvFullscreen = useVoiceSceneTvFullscreen(props);
	shown.push(tvFullscreen ? 'flat' : 'room');
	return null;
});

function render(props: BridgeProps): void {
	act(() => root.render(createElement(CallView, props)));
}

beforeEach(() => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	host = document.createElement('div');
	root = createRoot(host);
	shown = [];
	fullscreen.element = null;
	VoiceCallLayout.reset();
	VoiceSceneTvRequest.clearFullscreen();
	VoiceSceneTvRequest.stopCamera();
});

afterEach(() => {
	act(() => root.unmount());
});

describe('VoiceSceneTvRequest', () => {
	it('selection is per channel, local and not persisted', () => {
		VoiceSceneTvRequest.select('500', CAMERA);
		expect(VoiceSceneTvRequest.selected('500')).toEqual(CAMERA);
		expect(VoiceSceneTvRequest.selected('501')).toBeNull();
		expect(persistence.makePersistent).not.toHaveBeenCalled();
	});

	it('watching a camera belongs to the channel and ends when another source is picked', () => {
		VoiceSceneTvRequest.select('500', CAMERA);
		VoiceSceneTvRequest.watchCamera('500', CAMERA.identity);
		expect(VoiceSceneTvRequest.watchedCamera('500')).toBe(CAMERA.identity);
		expect(VoiceSceneTvRequest.watchedCamera('501')).toBeNull();
		VoiceSceneTvRequest.select('500', SCREEN);
		expect(VoiceSceneTvRequest.watchedCamera('500')).toBeNull();
	});

	it('fullscreen request shows the flat view with the source pinned and enters app fullscreen; leaving fullscreen returns to the room', async () => {
		VoiceCallLayout.setPinnedParticipant('user_1_a', 'camera');
		const enterFullscreen = vi.fn(async () => {
			fullscreen.element = host;
		});
		render({active: true, isFullscreen: false, enterFullscreen});
		expect(shown.at(-1)).toBe('room');
		await act(async () => VoiceSceneTvRequest.requestFullscreen(SCREEN));
		expect(shown.at(-1)).toBe('flat');
		expect(VoiceCallLayout.pinnedParticipantIdentity).toBe(SCREEN.identity);
		expect(VoiceCallLayout.pinnedParticipantSource).toBe('screen_share');
		expect(VoiceCallLayout.layoutMode).toBe('focus');
		expect(enterFullscreen).toHaveBeenCalledTimes(1);
		render({active: true, isFullscreen: true, enterFullscreen});
		expect(shown.at(-1)).toBe('flat');
		// Esc / the exit button: the browser leaves fullscreen.
		fullscreen.element = null;
		render({active: true, isFullscreen: false, enterFullscreen});
		expect(shown.at(-1)).toBe('room');
		expect(VoiceSceneTvRequest.fullscreen).toBeNull();
		// The call layout the viewer had before comes back.
		expect(VoiceCallLayout.pinnedParticipantIdentity).toBe('user_1_a');
		expect(VoiceCallLayout.pinnedParticipantSource).toBe('camera');
	});

	it('a camera is pinned as a camera', async () => {
		render({active: true, isFullscreen: false, enterFullscreen: async () => {}});
		fullscreen.element = host;
		await act(async () => VoiceSceneTvRequest.requestFullscreen(CAMERA));
		expect(VoiceCallLayout.pinnedParticipantSource).toBe('camera');
	});

	it('no fullscreen available → straight back to the room', async () => {
		render({active: true, isFullscreen: false, enterFullscreen: async () => {}});
		await act(async () => VoiceSceneTvRequest.requestFullscreen(SCREEN));
		expect(shown.at(-1)).toBe('room');
		expect(VoiceSceneTvRequest.fullscreen).toBeNull();
	});

	it('a call popout ignores the request', async () => {
		const enterFullscreen = vi.fn(async () => {});
		render({active: false, isFullscreen: false, enterFullscreen});
		await act(async () => VoiceSceneTvRequest.requestFullscreen(SCREEN));
		expect(shown.at(-1)).toBe('room');
		expect(enterFullscreen).not.toHaveBeenCalled();
	});
});
