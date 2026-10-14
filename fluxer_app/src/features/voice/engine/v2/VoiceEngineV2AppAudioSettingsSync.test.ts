// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	resolveVoiceNoiseSuppressionAssignment,
	VoiceNoiseSuppressionConfigSchema,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {describe, expect, it, vi} from 'vitest';

const fixture = vi.hoisted(() => ({assignment: null as unknown}));

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
vi.mock('@app/features/input/state/InputKeybind', () => ({default: {transmitMode: 'voice_activity'}}));
vi.mock('@app/features/voice/engine/VoiceInputAudioContext', () => ({}));
vi.mock('@app/features/voice/engine/VoiceSharedAudioContext', () => ({}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionChain', () => ({}));
vi.mock('@app/features/voice/utils/VoiceActivityGate', () => ({}));

import {createVoiceEngineV2AppAudioSettingsSnapshot} from '@app/features/voice/engine/v2/VoiceEngineV2AppAudioSettingsSync';
import {resolveVoiceInputConfig} from '@app/features/voice/utils/VoiceInputProcessor';
import {resolveVoicePipelineTuning} from '@app/features/voice/utils/VoicePipelineTuning';

function liveConfigVersion9Assignment(tuning: {pipeline_v2_gain_max_db?: number} = {}) {
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
			...tuning,
		}),
		'1000000000000000001',
	);
}

describe('voice audio settings snapshot with the live noise suppression config', () => {
	it('carries the assigned pipeline tuning into the settings snapshot', () => {
		const assignment = liveConfigVersion9Assignment({pipeline_v2_gain_max_db: 12});
		fixture.assignment = assignment;
		const snapshot = createVoiceEngineV2AppAudioSettingsSnapshot();
		expect(snapshot.pipelineV2Enabled).toBe(true);
		expect(snapshot.pipelineV2Tuning).toEqual(resolveVoicePipelineTuning(assignment));
		expect(snapshot.pipelineV2Tuning.gainMaxDb).toBe(12);
		expect(snapshot.suppressionStrength).toBe(80);
		expect(snapshot.autoGainControl).toBe(false);
	});

	it('gives the input processor the same tuning and strength as the settings snapshot', () => {
		fixture.assignment = liveConfigVersion9Assignment({pipeline_v2_gain_max_db: 12});
		const snapshot = createVoiceEngineV2AppAudioSettingsSnapshot();
		const config = resolveVoiceInputConfig();
		expect(config.pipelineV2Enabled).toBe(snapshot.pipelineV2Enabled);
		expect(config.pipelineV2Tuning).toEqual(snapshot.pipelineV2Tuning);
		expect(config.suppressionStrength).toBe(snapshot.suppressionStrength);
		expect(config.backend).toBe(snapshot.noiseSuppressionBackend);
	});
});
