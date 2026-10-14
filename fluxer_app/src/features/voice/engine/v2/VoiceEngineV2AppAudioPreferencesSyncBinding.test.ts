// SPDX-License-Identifier: AGPL-3.0-or-later

import type {Room} from 'livekit-client';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {}}));
vi.mock('@app/features/input/state/InputKeybind', () => ({default: {}}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({default: {}}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({
	default: {getNoiseSuppressionBackend: () => null, getStereoMicrophone: () => false},
}));
vi.mock('@app/features/voice/state/VoiceNoiseSuppressionRollout', () => ({
	default: {
		assignment: {
			enabled: true,
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			guild_overrides: [],
			user_targeted: false,
		},
	},
}));
vi.mock('@app/features/voice/state/ParticipantVolume', () => ({default: {}}));
vi.mock('@app/features/voice/state/StreamAudioPrefs', () => ({default: {}}));
vi.mock('@app/features/voice/utils/VoiceInputProcessor', () => ({}));
vi.mock('@app/features/voice/utils/VoiceProcessingProfile', () => ({}));

import Availability from '@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability';
import {resolveRuntimeVoiceProcessing} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime';
import {VOICE_PIPELINE_TUNING} from '@app/features/voice/utils/VoicePipelineTuning';
import type {ResolvedVoiceProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';
import {
	bindVoiceEngineV2AppAudioPreferencesSync,
	syncVoiceEngineV2AppAudioPreferences,
	type VoiceEngineV2AppAudioPreferencesSnapshot,
} from './VoiceEngineV2AppAudioPreferencesSyncBinding';

const previous: VoiceEngineV2AppAudioPreferencesSnapshot = {
	audioSettings: {
		inputVolume: 100,
		outputVolume: 100,
		vadThreshold: 50,
		vadAutoSensitivity: true,
		voiceActivityGate: true,
		requestedInputDeviceId: '',
		effectiveInputDeviceId: '',
		activeInputDeviceLabel: null,
		processingMode: 'voice',
		echoCancellation: true,
		browserNoiseSuppression: false,
		autoGainControl: false,
		deepFilter: true,
		deepFilterNoiseReductionLevel: 80,
		contentHint: '',
		noiseSuppressionBackend: 'deep_filter',
		suppressionStrength: 80,
		stereoCapture: false,
		pipelineV2Enabled: false,
		pipelineV2Tuning: VOICE_PIPELINE_TUNING,
	},
	participantVolumes: {},
	participantMutes: {},
	connectionVolumes: {},
	streamAudioRevision: 0,
	transmitMode: 'voice_activity',
	pushToMuteActive: false,
};

function sync(next: Partial<typeof previous.audioSettings>) {
	const adapter = {
		requestMicrophoneRefresh: vi.fn(async () => {}),
		configureVoiceInput: vi.fn(),
		handleInputKeybindChange: vi.fn(),
		applyAllLocalAudioPreferences: vi.fn(),
	};
	syncVoiceEngineV2AppAudioPreferences({} as Room, adapter, {warn: vi.fn()}, previous, {
		...previous,
		audioSettings: {...previous.audioSettings, ...next},
	});
	return adapter;
}

describe('pipeline audio sync', () => {
	it('restarts capture with saved AGC when the graph reports pipeline gain failure', () => {
		const saved: ResolvedVoiceProcessing = {
			pipelineV2Enabled: false,
			mode: 'voice',
			echoCancellation: true,
			browserNoiseSuppression: true,
			autoGainControl: true,
			deepFilter: false,
			deepFilterNoiseReductionLevel: 0,
			contentHint: '',
			noiseSuppressionBackend: 'standard',
			stereoCapture: false,
		};
		const adapter = {
			requestMicrophoneRefresh: vi.fn(async () => {}),
			configureVoiceInput: vi.fn(),
			handleInputKeybindChange: vi.fn(),
			applyAllLocalAudioPreferences: vi.fn(),
		};
		const getSnapshot = () => ({
			...previous,
			audioSettings: {...previous.audioSettings, ...resolveRuntimeVoiceProcessing(saved)},
		});
		const dispose = bindVoiceEngineV2AppAudioPreferencesSync(
			{} as Room,
			adapter,
			{warn: vi.fn()},
			{stores: [Availability], getSnapshot},
		);
		try {
			expect(getSnapshot().audioSettings.autoGainControl).toBe(false);
			Availability.markPipelineV2Failed();
			expect(getSnapshot().audioSettings.autoGainControl).toBe(true);
			expect(adapter.requestMicrophoneRefresh).toHaveBeenCalledWith(expect.any(Object), {republish: false});
			Availability.releaseExpiredFailures(Date.now());
			expect(getSnapshot().audioSettings.pipelineV2Enabled).toBe(false);
		} finally {
			dispose();
			Availability.releaseExpiredFailures(Date.now(), true);
		}
	});
	it('reconfigures the graph when only the pipeline flag changes', () => {
		const adapter = sync({pipelineV2Enabled: true});
		expect(adapter.configureVoiceInput).toHaveBeenCalledOnce();
		expect(adapter.requestMicrophoneRefresh).not.toHaveBeenCalled();
	});
	it('reconfigures the running graph without a capture refresh when only the tuning changes', () => {
		const adapter = sync({pipelineV2Tuning: {...VOICE_PIPELINE_TUNING, gainMaxDb: 10}});
		expect(adapter.configureVoiceInput).toHaveBeenCalledOnce();
		expect(adapter.requestMicrophoneRefresh).not.toHaveBeenCalled();
		expect(sync({pipelineV2Tuning: {...VOICE_PIPELINE_TUNING}}).configureVoiceInput).not.toHaveBeenCalled();
	});
	it('uses the existing capture refresh when the effective AGC constraint changes', () => {
		const adapter = sync({autoGainControl: true});
		expect(adapter.requestMicrophoneRefresh).toHaveBeenCalledWith(expect.any(Object), {republish: false});
	});
	it('reconfigures the processor when CPU fallback changes to RNNoise', () => {
		const adapter = sync({noiseSuppressionBackend: 'rnnoise', deepFilter: false});
		expect(adapter.configureVoiceInput).toHaveBeenCalledOnce();
	});
	it('restarts capture through the existing subscription when cold DeepFilter assets become ready', () => {
		Availability.setDeepFilterAssetState('loading');
		const adapter = {
			requestMicrophoneRefresh: vi.fn(async () => {}),
			configureVoiceInput: vi.fn(),
			handleInputKeybindChange: vi.fn(),
			applyAllLocalAudioPreferences: vi.fn(),
		};
		const dispose = bindVoiceEngineV2AppAudioPreferencesSync(
			{} as Room,
			adapter,
			{warn: vi.fn()},
			{
				stores: [Availability],
				getSnapshot: () => ({
					...previous,
					audioSettings: {
						...previous.audioSettings,
						pipelineV2Enabled: true,
						browserNoiseSuppression: Availability.deepFilterAssets !== 'ready',
						deepFilter: Availability.deepFilterAssets === 'ready',
						noiseSuppressionBackend: Availability.deepFilterAssets === 'ready' ? 'deep_filter' : 'standard',
					},
				}),
			},
		);
		try {
			Availability.setDeepFilterAssetState('ready');
			expect(adapter.requestMicrophoneRefresh).toHaveBeenCalledOnce();
		} finally {
			dispose();
		}
	});
});
