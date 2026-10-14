import type {VoiceProcessingMode} from '@app/features/voice/utils/VoiceProcessingProfile';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {deviceModes, voiceSettings, rollout, effective, prefetch, update} = vi.hoisted(() => ({
	rollout: {enabled: false, allow_user_override: true, enabled_backends: [] as Array<string>},
	effective: {backend: null as string | null, legacyNoiseSuppression: false, pipelineV2: false, stereo: false},
	prefetch: vi.fn(),
	update: vi.fn(),
	deviceModes: new Map<string, VoiceProcessingMode>(),
	voiceSettings: {
		voiceProcessingMode: 'voice' as VoiceProcessingMode,
		echoCancellation: true,
		autoGainControl: false,
		getNoiseSuppressionBackend: vi.fn(() => 'none'),
		getStereoMicrophone: () => false,
		getDeepFilterNoiseSuppression: () => false,
		getNoiseSuppression: () => effective.legacyNoiseSuppression,
		getVoiceProcessingModeForDeviceLabel: vi.fn<(label: string | null | undefined) => VoiceProcessingMode>(),
	},
}));

vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: voiceSettings}));
vi.mock('@app/features/voice/commands/VoiceSettingsCommands', () => ({update}));
vi.mock('@app/features/voice/state/VoiceNoiseSuppressionRollout', () => ({default: {assignment: rollout}}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({prefetchDeepFilterAssets: prefetch}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', () => ({
	readEffectiveNoiseSuppression: () => ({
		pipelineV2Enabled: effective.pipelineV2,
		rolloutApplied: rollout.enabled,
		backend: effective.backend,
		suppressionStrength: 80,
		stereoPreferred: effective.stereo,
		configVersion: 0,
	}),
}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {getState: () => ({inputDevices: []})},
}));
vi.mock('@app/features/voice/utils/VoiceDeviceManager', () => ({resolveEffectiveDeviceId: () => null}));

import NoiseSuppressionAvailability from '@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability';
import {
	getNoiseSuppressionChoiceValues,
	getSelectedNoiseSuppressionChoice,
	isAutoGainControlChoiceAvailable,
	isNoiseSuppressionAssignmentApplied,
	isStereoMicrophoneChoiceAvailable,
	setNoiseSuppressionChoice,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionChoices';

beforeEach(() => {
	update.mockClear();
	voiceSettings.getNoiseSuppressionBackend.mockReturnValue('none');
	NoiseSuppressionAvailability.failures.clear();
	NoiseSuppressionAvailability.setVoiceInputGraphUnavailable(false);
});

afterEach(() => vi.unstubAllGlobals());

it('saves a DeepFilter preference without downloading assets', () => {
	prefetch.mockClear();
	setNoiseSuppressionChoice('deep_filter');
	expect(prefetch).not.toHaveBeenCalled();
});

describe('noise suppression choices under the admin assignment', () => {
	beforeEach(() => {
		effective.legacyNoiseSuppression = true;
	});

	afterEach(() => {
		rollout.enabled = false;
		rollout.allow_user_override = true;
		rollout.enabled_backends = [];
		effective.backend = null;
		effective.legacyNoiseSuppression = false;
	});

	it('shows only the assigned backend when the assignment applies without user override', () => {
		rollout.enabled = true;
		rollout.allow_user_override = false;
		rollout.enabled_backends = ['deep_filter'];
		effective.backend = 'deep_filter';
		expect(getNoiseSuppressionChoiceValues()).toEqual(['deep_filter']);
		expect(getSelectedNoiseSuppressionChoice()).toBe('deep_filter');
	});

	it('keeps the legacy choices and preference when no assignment applies', () => {
		expect(getNoiseSuppressionChoiceValues()).toEqual(['deep_filter', 'standard', 'none']);
		expect(getSelectedNoiseSuppressionChoice()).toBe('standard');
	});

	it('lists the allowed supported backends when user override is allowed', () => {
		rollout.enabled = true;
		rollout.enabled_backends = ['standard', 'none'];
		effective.backend = 'deep_filter';
		expect(getNoiseSuppressionChoiceValues()).toEqual(['none', 'standard']);
		expect(getSelectedNoiseSuppressionChoice()).toBe('none');
	});

	it('shows the fallback backend the assignment resolves to on an unsupported device', () => {
		rollout.enabled = true;
		rollout.allow_user_override = false;
		rollout.enabled_backends = ['deep_filter'];
		effective.backend = 'standard';
		expect(getNoiseSuppressionChoiceValues()).toEqual(['standard']);
		expect(getSelectedNoiseSuppressionChoice()).toBe('standard');
	});

	it('saves only the legacy flags when the assigned backend is picked', () => {
		rollout.enabled = true;
		rollout.allow_user_override = false;
		effective.backend = 'deep_filter';
		update.mockClear();
		Reflect.deleteProperty(voiceSettings, 'noiseSuppressionBackend');
		setNoiseSuppressionChoice('deep_filter');
		expect(update).toHaveBeenCalledExactlyOnceWith({deepFilterNoiseSuppression: true, noiseSuppression: false});
		expect(voiceSettings).not.toHaveProperty('noiseSuppressionBackend');
	});

	it.each([
		{enabled: true, applied: true},
		{enabled: false, applied: false},
	])('reports whether the assignment applies (enabled: $enabled)', ({enabled, applied}) => {
		rollout.enabled = enabled;
		expect(isNoiseSuppressionAssignmentApplied()).toBe(applied);
	});
});

describe('automatic gain control choice', () => {
	beforeEach(() => {
		voiceSettings.echoCancellation = true;
		voiceSettings.autoGainControl = false;
		voiceSettings.getVoiceProcessingModeForDeviceLabel.mockReset();
		voiceSettings.getVoiceProcessingModeForDeviceLabel.mockReturnValue('custom');
	});

	afterEach(() => {
		effective.pipelineV2 = false;
		effective.stereo = false;
	});

	it.each(['custom', 'voice'] as const)('hides the switch in %s mode while voice pipeline v2 overrides it', (mode) => {
		voiceSettings.getVoiceProcessingModeForDeviceLabel.mockReturnValue(mode);
		effective.pipelineV2 = true;
		expect(isAutoGainControlChoiceAvailable('Headset microphone')).toBe(false);
	});

	it('shows the switch when voice pipeline v2 is off', () => {
		expect(isAutoGainControlChoiceAvailable('Headset microphone')).toBe(true);
	});

	it('keeps the switch reachable when turning it off would restore stereo capture', () => {
		effective.pipelineV2 = true;
		effective.stereo = true;
		voiceSettings.echoCancellation = false;
		voiceSettings.autoGainControl = true;
		expect(isAutoGainControlChoiceAvailable('USB audio interface')).toBe(true);
	});
});

describe('stereo microphone choice for the selected device', () => {
	beforeEach(() => {
		deviceModes.clear();
		voiceSettings.voiceProcessingMode = 'voice';
		voiceSettings.echoCancellation = true;
		voiceSettings.autoGainControl = false;
		voiceSettings.getVoiceProcessingModeForDeviceLabel.mockReset();
		voiceSettings.getVoiceProcessingModeForDeviceLabel.mockImplementation(
			(label) => (label ? deviceModes.get(label) : undefined) ?? voiceSettings.voiceProcessingMode,
		);
	});

	it('shows the switch for a device using direct input when the global mode is focused voice', () => {
		deviceModes.set('USB audio interface', 'studio');
		expect(isStereoMicrophoneChoiceAvailable('USB audio interface')).toBe(true);
		expect(voiceSettings.getVoiceProcessingModeForDeviceLabel).toHaveBeenCalledWith('USB audio interface');
	});

	it('hides the switch for a device with custom processing when the global mode is direct input', () => {
		voiceSettings.voiceProcessingMode = 'studio';
		deviceModes.set('Headset microphone', 'custom');
		expect(isStereoMicrophoneChoiceAvailable('Headset microphone')).toBe(false);
	});

	it('shows the switch for a custom device profile with processing disabled', () => {
		deviceModes.set('USB audio interface', 'custom');
		voiceSettings.echoCancellation = false;
		expect(isStereoMicrophoneChoiceAvailable('USB audio interface')).toBe(true);
	});

	it.each([
		{mode: 'voice' as const, available: false},
		{mode: 'studio' as const, available: true},
	])('uses the global $mode profile when the device has no override', ({mode, available}) => {
		voiceSettings.voiceProcessingMode = mode;
		expect(isStereoMicrophoneChoiceAvailable('Unconfigured microphone')).toBe(available);
		expect(isStereoMicrophoneChoiceAvailable(null)).toBe(available);
	});
});
