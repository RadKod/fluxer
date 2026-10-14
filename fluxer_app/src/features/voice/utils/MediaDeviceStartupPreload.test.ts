// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => {
	let markDevicesInUse = () => {};
	const devicesInUse = new Promise<void>((resolve) => {
		markDevicesInUse = resolve;
	});
	return {ensureDevices: vi.fn(async () => {}), disposeListener: vi.fn(), devicesInUse, markDevicesInUse};
});
vi.mock('@app/features/permissions/system/state/MediaPermission', () => ({
	default: {
		isMicrophoneGranted: () => true,
		isCameraGranted: () => true,
		isInitialized: () => true,
		getMicrophonePermissionState: () => 'granted',
		getCameraPermissionState: () => 'granted',
		addChangeListener: (listener: () => void) => {
			listener();
			return state.disposeListener;
		},
	},
}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {
		getState: () => ({permissionStatus: {audio: 'idle', video: 'idle'}}),
		ensureDevices: state.ensureDevices,
		whenDevicesInUse: () => state.devicesInUse,
	},
}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: {}}));
vi.mock('@app/features/voice/engine/VoiceInputAudioContext', () => ({}));
vi.mock('@app/features/voice/utils/VoiceProcessingProfile', () => ({getActiveVoiceProcessingMode: () => 'custom'}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', () => ({
	readRequestedNoiseSuppressionBackend: () => 'deep_filter',
}));

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('waits for the first device use before preloading granted devices, and never requests DeepFilter assets', async () => {
	vi.useFakeTimers();
	vi.stubGlobal('window', globalThis);
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async (url: string) =>
				new Response(url.endsWith('.wasm') ? new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) : new Uint8Array([31, 139])),
		),
	);
	const {startMediaDeviceStartupPreload} = await import('./MediaDeviceStartupPreload');
	const stop = startMediaDeviceStartupPreload();
	try {
		await vi.advanceTimersByTimeAsync(20_001);
		expect(state.ensureDevices).not.toHaveBeenCalled();
		state.markDevicesInUse();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.ensureDevices).toHaveBeenCalledWith({forceRefresh: false, confirmPermissionTypes: ['audio', 'video']});
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		stop();
	}
	expect(state.disposeListener).toHaveBeenCalledOnce();
});
