// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {VoiceReconnectionManager} from '@app/features/voice/components/VoiceReconnectionManager';
import {act, createElement, useSyncExternalStore} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const engine = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	let version = 0;
	return {
		room: null as object | null,
		shouldReconnect: false,
		connect: vi.fn(),
		bump() {
			version++;
			for (const listener of listeners) listener();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getVersion: () => version,
	};
});

vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {
		get room() {
			return engine.room;
		},
		connected: true,
		getLastConnectedChannel: () => ({guildId: '1', channelId: '2'}),
		getShouldReconnect: () => engine.shouldReconnect,
		connectToVoiceChannel: engine.connect,
		markReconnectionAttempted: () => {
			engine.shouldReconnect = false;
			engine.bump();
		},
	},
	useMediaEngineVersion: () => useSyncExternalStore(engine.subscribe, engine.getVersion),
}));
vi.mock('@app/features/gateway/transport/GatewayConnection', () => ({default: {socket: {}}}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		info() {}
		error() {}
	},
}));
vi.mock('@app/features/ui/commands/ModalCommands', () => ({modal: vi.fn(), pushWithKey: vi.fn()}));
vi.mock('@app/features/voice/components/modals/AudioPlaybackPermissionModal', () => ({
	AudioPlaybackPermissionModal: () => null,
}));
vi.mock('@livekit/components-react', () => ({useAudioPlayback: () => ({canPlayAudio: true, startAudio: vi.fn()})}));

let host: HTMLDivElement;
let root: Root;

async function setRoom(room: object | null): Promise<void> {
	await act(async () => {
		engine.room = room;
		engine.bump();
	});
}

async function disconnectWithError(): Promise<void> {
	await act(async () => {
		engine.room = null;
		engine.shouldReconnect = true;
		engine.bump();
	});
	await act(async () => {
		vi.advanceTimersByTime(2000);
	});
}

beforeEach(async () => {
	(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
	vi.useFakeTimers();
	engine.room = null;
	engine.shouldReconnect = false;
	engine.connect.mockClear();
	host = document.createElement('div');
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root.render(createElement(VoiceReconnectionManager));
	});
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

describe('VoiceReconnectionManager', () => {
	it('reconnects after every error disconnect in the same session', async () => {
		await setRoom({});
		await disconnectWithError();
		expect(engine.connect).toHaveBeenCalledTimes(1);

		await setRoom({});
		await disconnectWithError();
		expect(engine.connect).toHaveBeenCalledTimes(2);
	});

	it('does not retry while the reconnection has not produced a room', async () => {
		await setRoom({});
		await disconnectWithError();
		expect(engine.connect).toHaveBeenCalledTimes(1);

		await disconnectWithError();
		expect(engine.connect).toHaveBeenCalledTimes(1);
	});
});
