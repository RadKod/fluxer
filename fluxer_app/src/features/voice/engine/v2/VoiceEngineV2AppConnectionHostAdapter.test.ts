// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));
vi.mock('@lingui/react/macro', () => ({
	Trans: ({children}: {children: unknown}) => children,
	useLingui: () => ({i18n: {locale: 'en-US', _: (descriptor: {message: string}) => descriptor.message}}),
}));

const suspendSharedVoiceAudioContext = vi.fn();
vi.mock('@app/features/voice/engine/VoiceSharedAudioContext', () => ({
	getSharedVoiceAudioContext: () => null,
	acquireSharedVoiceAudioContext: vi.fn(),
	suspendSharedVoiceAudioContext,
}));
vi.mock('@app/features/voice/engine/VoiceChannelConnector', () => ({sendVoiceStateDisconnect: vi.fn()}));
vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class Logger {
		static create() {
			return new Logger();
		}
		debug = vi.fn();
		info = vi.fn();
		warn = vi.fn();
		error = vi.fn();
	},
}));
vi.mock('@app/features/voice/utils/CodecCapabilityDetector', () => ({
	findVideoPublishCodecPolicyViolation: () => null,
	getRoomVideoPublishDefaults: () => ({}),
}));
vi.mock('@app/features/voice/utils/GpuEncoderCapabilities', () => ({getH264HardwareProfilesSync: () => null}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionSelection', () => ({
	setNoiseSuppressionScopeGuildId: vi.fn(),
}));
vi.mock('@app/features/voice/utils/ScreenShareOptions', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/features/voice/utils/ScreenShareOptions')>()),
	SCREEN_SHARE_MAX_VIDEO_BITRATE_BPS: 1,
}));
vi.mock('@app/features/voice/utils/VideoDecoderCapabilities', () => ({
	clearScreenShareDecodeFailures: vi.fn(),
	getVideoDecoderExclusionsSync: () => null,
	loadVideoDecoderExclusions: async () => null,
}));

// The adapter's import graph reaches MediaEngineFacade, which subscribes to the adapter singleton on load; loading the facade first keeps that cycle in app order.
await import('@app/features/voice/engine/MediaEngineFacade');
const {VoiceEngineV2AppConnectionHostAdapter} = await import(
	'@app/features/voice/engine/v2/VoiceEngineV2AppConnectionHostAdapter'
);

beforeEach(() => {
	suspendSharedVoiceAudioContext.mockClear();
});

describe('shared voice audio at the end of a call', () => {
	it('leaving the channel suspends the shared voice context', () => {
		const adapter = new VoiceEngineV2AppConnectionHostAdapter();
		adapter.startConnection('1', '2');
		adapter.disconnectFromVoiceChannel('user');
		expect(suspendSharedVoiceAudioContext).toHaveBeenCalledTimes(1);
	});

	it('a dropped room suspends the shared voice context', () => {
		const adapter = new VoiceEngineV2AppConnectionHostAdapter();
		adapter.startConnection('1', '2');
		adapter.markDisconnected('error');
		expect(suspendSharedVoiceAudioContext).toHaveBeenCalledTimes(1);
	});

	it('voice cleanup suspends the shared voice context', () => {
		const adapter = new VoiceEngineV2AppConnectionHostAdapter();
		adapter.cleanup();
		expect(suspendSharedVoiceAudioContext).toHaveBeenCalledTimes(1);
	});

	it('a channel move keeps the shared voice context running', () => {
		const adapter = new VoiceEngineV2AppConnectionHostAdapter();
		adapter.startConnection('1', '2');
		adapter.disconnectForChannelMove();
		expect(suspendSharedVoiceAudioContext).not.toHaveBeenCalled();
	});
});
