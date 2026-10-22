// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
	resolveVoiceNoiseSuppressionAssignment,
	VoiceNoiseSuppressionConfigSchema,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import type {Room} from 'livekit-client';
import {afterEach, describe, expect, it, vi} from 'vitest';

const fixture = vi.hoisted(() => ({assignment: null as unknown, transmitMode: 'voice_activity'}));

vi.mock('@app/features/voice/state/VoiceNoiseSuppressionRollout', () => ({
	default: {
		get assignment() {
			return fixture.assignment;
		},
	},
}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({
	default: {
		inputDeviceId: '',
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		deepFilterNoiseSuppression: false,
		deepFilterNoiseSuppressionLevel: 80,
		getVoiceProcessingModeForDeviceLabel: () => 'voice',
		getNoiseSuppressionBackend: () => null,
		getStereoMicrophone: () => false,
		getInputVolume: () => 100,
		getOutputVolume: () => 100,
		getVadThreshold: () => 50,
		getVadAutoSensitivity: () => true,
		getInputDeviceId: () => '',
	},
}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {getState: () => ({inputDevices: []})},
}));
vi.mock('@app/features/input/state/InputKeybind', () => ({
	default: {
		get transmitMode() {
			return fixture.transmitMode;
		},
	},
}));
vi.mock('@app/features/voice/engine/VoiceInputAudioContext', () => ({}));
vi.mock('@app/features/voice/engine/VoiceSharedAudioContext', () => ({}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionChain', () => ({}));
vi.mock('@app/features/voice/utils/VoiceActivityGate', () => ({}));
vi.mock('@app/features/experiment/state/ExperimentAssignments', () => ({default: {}}));
vi.mock('@app/features/voice/state/ParticipantVolume', () => ({default: {}}));
vi.mock('@app/features/voice/state/StreamAudioPrefs', () => ({default: {}}));

import {
	syncVoiceEngineV2AppAudioPreferences,
	type VoiceEngineV2AppAudioPreferencesSnapshot,
} from '@app/features/voice/engine/v2/VoiceEngineV2AppAudioPreferencesSyncBinding';
import {createVoiceEngineV2AppAudioSettingsSnapshot} from '@app/features/voice/engine/v2/VoiceEngineV2AppAudioSettingsSync';
import VoiceProcessingOverride from '@app/features/voice/state/VoiceProcessingOverride';
import {isVoiceActivityGateEnabled, resolveVoiceInputConfig} from '@app/features/voice/utils/VoiceInputProcessor';

// The live rollout: pipeline v2 with DeepFilter for everyone.
function pipelineV2Assignment() {
	return resolveVoiceNoiseSuppressionAssignment(
		VoiceNoiseSuppressionConfigSchema.parse({
			enabled: true,
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			config_version: 9,
			default_backend: 'deep_filter',
			enabled_backends: ['deep_filter'],
			allow_user_override: false,
			rollout_basis_points: 10000,
			suppression_strength: 80,
		}),
		'1000000000000000001',
	);
}

function preferences(): VoiceEngineV2AppAudioPreferencesSnapshot {
	return {
		audioSettings: createVoiceEngineV2AppAudioSettingsSnapshot(),
		participantVolumes: {},
		participantMutes: {},
		connectionVolumes: {},
		streamAudioRevision: 0,
		pushToMuteActive: false,
	};
}

afterEach(() => {
	VoiceProcessingOverride.setMusic(null);
	fixture.transmitMode = 'voice_activity';
});

describe.each([
	['pipeline v2 on', pipelineV2Assignment],
	['pipeline v2 off', () => INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT],
])('music processing over saved voice settings (%s)', (_name, assignment) => {
	it('turns a headphone singer into studio: no echo cancellation, suppression, gain control, leveller or gate', () => {
		fixture.assignment = assignment();
		VoiceProcessingOverride.setMusic('headphones');
		expect(createVoiceEngineV2AppAudioSettingsSnapshot()).toMatchObject({
			processingMode: 'studio',
			pipelineV2Enabled: false,
			echoCancellation: false,
			browserNoiseSuppression: false,
			autoGainControl: false,
			deepFilter: false,
			noiseSuppressionBackend: 'none',
			contentHint: 'music',
			voiceActivityGate: false,
			stereoCapture: false,
		});
		expect(resolveVoiceInputConfig()).toMatchObject({
			processingMode: 'studio',
			pipelineV2Enabled: false,
			backend: 'none',
			gateEnabled: false,
		});
	});

	it('keeps only echo cancellation for a singer on speakers', () => {
		fixture.assignment = assignment();
		VoiceProcessingOverride.setMusic('speakers');
		expect(createVoiceEngineV2AppAudioSettingsSnapshot()).toMatchObject({
			processingMode: 'studio',
			pipelineV2Enabled: false,
			echoCancellation: true,
			browserNoiseSuppression: false,
			autoGainControl: false,
			deepFilter: false,
			noiseSuppressionBackend: 'none',
			contentHint: 'music',
			voiceActivityGate: false,
		});
		expect(isVoiceActivityGateEnabled()).toBe(false);
	});

	it('gives back exactly the saved settings, gate included, once the song is over', () => {
		fixture.assignment = assignment();
		const saved = createVoiceEngineV2AppAudioSettingsSnapshot();
		const savedConfig = resolveVoiceInputConfig();
		expect(saved.voiceActivityGate).toBe(true);
		VoiceProcessingOverride.setMusic('headphones');
		VoiceProcessingOverride.setMusic(null);
		expect(createVoiceEngineV2AppAudioSettingsSnapshot()).toEqual(saved);
		expect(resolveVoiceInputConfig()).toEqual(savedConfig);
	});

	it('restarts the capture on the way in and out without re-publishing the mic', () => {
		fixture.assignment = assignment();
		const adapter = {
			requestMicrophoneRefresh: vi.fn(async () => {}),
			configureVoiceInput: vi.fn(),
			handleInputKeybindChange: vi.fn(),
			applyAllLocalAudioPreferences: vi.fn(),
		};
		const room = {} as Room;
		const logger = {warn: vi.fn()};
		const before = preferences();
		VoiceProcessingOverride.setMusic('speakers');
		const singing = preferences();
		syncVoiceEngineV2AppAudioPreferences(room, adapter, logger, before, singing);
		VoiceProcessingOverride.setMusic(null);
		syncVoiceEngineV2AppAudioPreferences(room, adapter, logger, singing, preferences());
		expect(adapter.requestMicrophoneRefresh.mock.calls).toEqual([
			[room, {republish: false}],
			[room, {republish: false}],
		]);
	});
});

describe('the override store', () => {
	it('tells the audio settings sync when it changes', () => {
		const listener = vi.fn();
		const unsubscribe = VoiceProcessingOverride.subscribe(listener);
		VoiceProcessingOverride.setMusic('speakers');
		VoiceProcessingOverride.setMusic('speakers');
		VoiceProcessingOverride.setMusic(null);
		unsubscribe();
		VoiceProcessingOverride.setMusic('headphones');
		expect(listener).toHaveBeenCalledTimes(2);
	});
});
