// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceProcessingMode} from '@app/features/voice/utils/VoiceProcessingProfile';
import {INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {voiceSettings, prefetch, rollout, update} = vi.hoisted(() => ({
	prefetch: vi.fn(),
	update: vi.fn(),
	rollout: {assignment: {}},
	voiceSettings: {
		voiceProcessingMode: 'voice' as VoiceProcessingMode,
		echoCancellation: true,
		autoGainControl: false,
		getNoiseSuppressionBackend: vi.fn(() => 'none'),
		getStereoMicrophone: () => false,
		getVoiceProcessingModeForDeviceLabel: vi.fn<(label: string | null | undefined) => VoiceProcessingMode>(),
	},
}));

vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: voiceSettings}));
vi.mock('@app/features/voice/state/VoiceNoiseSuppressionRollout', () => ({default: rollout}));
vi.mock('@app/features/voice/commands/VoiceSettingsCommands', () => ({update}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({prefetchDeepFilterAssets: prefetch}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {getState: () => ({inputDevices: []})},
}));
vi.mock('@app/features/voice/utils/VoiceDeviceManager', () => ({resolveEffectiveDeviceId: () => null}));

import NoiseSuppressionAvailability from '@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability';
import {
	getNoiseSuppressionChoiceValues,
	getSelectedNoiseSuppressionChoice,
	isStereoMicrophoneChoiceAvailable,
	setNoiseSuppressionChoice,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionChoices';

beforeEach(() => {
	rollout.assignment = {...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT};
	update.mockClear();
	voiceSettings.getNoiseSuppressionBackend.mockReturnValue('none');
	NoiseSuppressionAvailability.failures.clear();
	NoiseSuppressionAvailability.setVoiceInputGraphUnavailable(false);
});

afterEach(() => vi.unstubAllGlobals());

describe('operator noise suppression choices', () => {
	beforeEach(() => {
		vi.stubGlobal('AudioWorkletNode', class {});
		voiceSettings.getNoiseSuppressionBackend.mockReturnValue('rnnoise');
		rollout.assignment = {
			...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
			enabled: true,
			user_targeted: true,
			backend: 'gate',
			source: 'user_rule',
			enabled_backends: ['gate'],
			allow_user_override: true,
		};
	});

	it('lists only allowed supported backends and shows the assigned backend over an excluded local preference', () => {
		expect.soft(getNoiseSuppressionChoiceValues()).toEqual(['gate']);
		expect(getSelectedNoiseSuppressionChoice()).toBe('gate');
	});

	it('does not save a backend excluded by the operator', () => {
		setNoiseSuppressionChoice('rnnoise');
		expect(update).not.toHaveBeenCalled();
		expect(voiceSettings).not.toHaveProperty('noiseSuppressionBackend');
	});

	it('shows stereo availability from an operator-forced passthrough profile', () => {
		voiceSettings.voiceProcessingMode = 'custom';
		voiceSettings.echoCancellation = false;
		voiceSettings.autoGainControl = false;
		voiceSettings.getVoiceProcessingModeForDeviceLabel.mockReturnValue('custom');
		rollout.assignment = {...rollout.assignment, backend: 'none', enabled_backends: ['none']};
		expect(isStereoMicrophoneChoiceAvailable(null)).toBe(true);
	});
});
