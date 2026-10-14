// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

const beginMicrophoneSession = vi.hoisted(() => vi.fn());
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({beginMicrophoneSession}));

import {VoiceEngineV2AppLiveKitExecutionAdapter} from './VoiceEngineV2AppLiveKitExecutionAdapter';

describe('CPU failure session boundary', () => {
	it('preserves CPU failures across reconnects and resets them only for a new call', async () => {
		beginMicrophoneSession.mockClear();
		const adapter = new VoiceEngineV2AppLiveKitExecutionAdapter({
			media: {
				enableMicrophone: vi.fn(),
				disableMicrophone: vi.fn(),
				setMicrophoneEnabled: vi.fn(),
				setCameraEnabled: vi.fn(),
				updateCameraEncoding: vi.fn(),
			},
			connection: {connectToVoiceServer: vi.fn(), disconnectFromVoiceChannel: vi.fn()},
			screenShare: {
				publishControllerScreenViaLiveKitFlows: vi.fn(),
				unpublishControllerScreenViaLiveKitFlows: vi.fn(),
				updateActiveScreenShareSettings: vi.fn(),
				setScreenShareAudioMuted: vi.fn(),
			},
			getRoom: () => null,
			logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn()},
		});
		const options = {url: 'wss://voice.invalid', token: 'test'};
		await adapter.connect(options);
		expect(beginMicrophoneSession).toHaveBeenLastCalledWith(undefined, true);
		await adapter.disconnect('network');
		await adapter.connect(options);
		expect(beginMicrophoneSession).toHaveBeenLastCalledWith(undefined, false);
		await adapter.disconnect('replaced');
		await adapter.connect(options);
		expect(beginMicrophoneSession).toHaveBeenLastCalledWith(undefined, false);
		await adapter.disconnect('user');
		await adapter.connect(options);
		expect(beginMicrophoneSession).toHaveBeenLastCalledWith(undefined, true);
	});
});
