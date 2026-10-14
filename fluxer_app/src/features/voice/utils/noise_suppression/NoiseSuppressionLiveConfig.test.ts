// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	resolveVoiceNoiseSuppressionAssignment,
	VoiceNoiseSuppressionConfigSchema,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {rollout, voiceSettings, update} = vi.hoisted(() => ({
	rollout: {assignment: null as unknown},
	update: vi.fn(),
	voiceSettings: {
		voiceProcessingMode: 'voice',
		inputDeviceId: '',
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		deepFilterNoiseSuppression: false,
		deepFilterNoiseSuppressionLevel: 80,
		noiseSuppressionBackend: undefined as string | undefined,
		getNoiseSuppressionBackend: () => 'standard',
		getStereoMicrophone: () => false,
		getDeepFilterNoiseSuppression: () => false,
		getNoiseSuppression: () => true,
		getVoiceProcessingModeForDeviceLabel: () => 'voice',
	},
}));

vi.mock('@app/features/voice/state/VoiceNoiseSuppressionRollout', () => ({default: rollout}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: voiceSettings}));
vi.mock('@app/features/voice/commands/VoiceSettingsCommands', () => ({update}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({prefetchDeepFilterAssets: vi.fn()}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {getState: () => ({inputDevices: []})},
}));
vi.mock('@app/features/voice/utils/VoiceDeviceManager', () => ({resolveEffectiveDeviceId: () => null}));

const {default: availability} = await import('./NoiseSuppressionAvailability');
const choices = await import('./NoiseSuppressionChoices');
const {resolveRuntimeVoiceProcessing} = await import('./NoiseSuppressionRuntime');
const {resolveVoiceProcessingFromStateForDeviceLabel} = await import(
	'@app/features/voice/utils/VoiceProcessingProfile'
);

const LIVE_CONFIG_VERSION_9 = {
	enabled: true,
	pipeline_v2_enabled: true,
	pipeline_v2_all: true,
	config_version: 9,
	default_backend: 'deep_filter',
	enabled_backends: ['deep_filter'],
	allow_user_override: false,
	rollout_basis_points: 10000,
	suppression_strength: 80,
};

describe('noise suppression with the live voice configuration (config_version 9)', () => {
	beforeEach(() => {
		vi.stubGlobal('AudioWorkletNode', class {});
		availability.failures.clear();
		availability.setVoiceInputGraphUnavailable(false);
		availability.setDeepFilterAssetState('ready');
		availability.setInputContextRate(48000);
		rollout.assignment = resolveVoiceNoiseSuppressionAssignment(
			VoiceNoiseSuppressionConfigSchema.parse(LIVE_CONFIG_VERSION_9),
			'1000000000000000001',
		);
		voiceSettings.noiseSuppressionBackend = undefined;
		update.mockClear();
	});

	afterEach(() => vi.unstubAllGlobals());

	it('offers only the assigned DeepFilter backend, selected and locked over a saved local preference', () => {
		expect(choices.isNoiseSuppressionAssignmentApplied()).toBe(true);
		expect(choices.isNoiseSuppressionChoiceExpanded()).toBe(false);
		expect(choices.getNoiseSuppressionChoiceValues()).toEqual(['deep_filter']);
		expect(choices.getSelectedNoiseSuppressionChoice()).toBe('deep_filter');
		expect(choices.isNoiseSuppressionChoiceSelectable('deep_filter')).toBe(false);
		expect(choices.isNoiseSuppressionChoiceSelectable('standard')).toBe(false);
	});

	it('runs voice pipeline v2 with DeepFilter and hides the automatic gain switch it overrides', () => {
		expect(
			resolveRuntimeVoiceProcessing(resolveVoiceProcessingFromStateForDeviceLabel(voiceSettings as never, null)),
		).toMatchObject({
			pipelineV2Enabled: true,
			noiseSuppressionBackend: 'deep_filter',
			deepFilter: true,
			deepFilterNoiseReductionLevel: 80,
			browserNoiseSuppression: false,
			autoGainControl: false,
			stereoCapture: false,
		});
		expect(choices.isAutoGainControlChoiceAvailable(null)).toBe(false);
	});

	it('keeps the user override closed: picking the assigned backend writes only the legacy flags', () => {
		choices.setNoiseSuppressionChoice('deep_filter');
		expect(update).toHaveBeenCalledWith({deepFilterNoiseSuppression: true, noiseSuppression: false});
		expect(voiceSettings.noiseSuppressionBackend).toBeUndefined();
	});
});
