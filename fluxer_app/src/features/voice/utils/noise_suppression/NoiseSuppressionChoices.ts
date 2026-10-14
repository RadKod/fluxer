// SPDX-License-Identifier: AGPL-3.0-or-later

import * as VoiceSettingsCommands from '@app/features/voice/commands/VoiceSettingsCommands';
import VoiceNoiseSuppressionRollout from '@app/features/voice/state/VoiceNoiseSuppressionRollout';
import VoiceSettings from '@app/features/voice/state/VoiceSettings';
import NoiseSuppressionAvailability from '@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability';
import {
	isNoiseSuppressionBackendSupported,
	isVoiceNoiseSuppressionBackend,
	VOICE_NOISE_SUPPRESSION_BACKENDS,
	type VoiceNoiseSuppressionBackend,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionBackends';
import {readEffectiveNoiseSuppression} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime';
import {
	applyNoiseSuppressionOverride,
	readNoiseSuppressionRuntimeCapabilities,
	supportsStereoCapture,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionSelection';
import {
	legacyNoiseSuppressionBackend,
	resolveVoiceProcessingFromStateForDeviceLabel,
} from '@app/features/voice/utils/VoiceProcessingProfile';

export const NOISE_SUPPRESSION_UI_SAMPLE_RATE = 48000;

export function isNoiseSuppressionChoiceExpanded(): boolean {
	const assignment = VoiceNoiseSuppressionRollout.assignment;
	if (!assignment.enabled || !assignment.allow_user_override) return false;
	return readEffectiveNoiseSuppression(NOISE_SUPPRESSION_UI_SAMPLE_RATE).rolloutApplied;
}

function readAssignedNoiseSuppressionBackend(): VoiceNoiseSuppressionBackend | null {
	const effective = readEffectiveNoiseSuppression(NOISE_SUPPRESSION_UI_SAMPLE_RATE);
	return effective.rolloutApplied ? effective.backend : null;
}

export function getNoiseSuppressionChoiceValues(): ReadonlyArray<VoiceNoiseSuppressionBackend> {
	if (!isNoiseSuppressionChoiceExpanded()) {
		const assigned = readAssignedNoiseSuppressionBackend();
		return assigned != null ? [assigned] : ['deep_filter', 'standard', 'none'];
	}
	const capabilities = readNoiseSuppressionRuntimeCapabilities(NOISE_SUPPRESSION_UI_SAMPLE_RATE);
	const allowed = new Set(VoiceNoiseSuppressionRollout.assignment.enabled_backends);
	return VOICE_NOISE_SUPPRESSION_BACKENDS.filter(
		(backend) => allowed.has(backend) && isNoiseSuppressionBackendSupported(backend, capabilities),
	);
}

export function getSelectedNoiseSuppressionChoice(): VoiceNoiseSuppressionBackend {
	const values = getNoiseSuppressionChoiceValues();
	if (isNoiseSuppressionChoiceExpanded()) {
		const preference = VoiceSettings.getNoiseSuppressionBackend();
		if (isVoiceNoiseSuppressionBackend(preference) && values.includes(preference)) return preference;
		const effective = readEffectiveNoiseSuppression(NOISE_SUPPRESSION_UI_SAMPLE_RATE);
		if (effective.backend != null && values.includes(effective.backend)) return effective.backend;
		return values[0] ?? 'standard';
	}
	return (
		readAssignedNoiseSuppressionBackend() ??
		legacyNoiseSuppressionBackend(VoiceSettings.getDeepFilterNoiseSuppression(), VoiceSettings.getNoiseSuppression())
	);
}

export function isNoiseSuppressionChoiceSelectable(backend: VoiceNoiseSuppressionBackend): boolean {
	if (!readEffectiveNoiseSuppression(NOISE_SUPPRESSION_UI_SAMPLE_RATE).rolloutApplied) return true;
	const assignment = VoiceNoiseSuppressionRollout.assignment;
	return (
		assignment.allow_user_override &&
		assignment.enabled_backends.includes(backend) &&
		isNoiseSuppressionBackendSupported(
			backend,
			readNoiseSuppressionRuntimeCapabilities(NOISE_SUPPRESSION_UI_SAMPLE_RATE),
		)
	);
}

export function setNoiseSuppressionChoice(backend: VoiceNoiseSuppressionBackend): void {
	if (isNoiseSuppressionChoiceExpanded() && !isNoiseSuppressionChoiceSelectable(backend)) return;
	NoiseSuppressionAvailability.clearBackendFailure(backend);
	if (isNoiseSuppressionChoiceExpanded()) {
		VoiceSettings.noiseSuppressionBackend = backend;
		if (backend === 'deep_filter' || backend === 'standard' || backend === 'none') {
			VoiceSettingsCommands.update({
				deepFilterNoiseSuppression: backend === 'deep_filter',
				noiseSuppression: backend === 'standard',
			});
		}
		return;
	}
	VoiceSettingsCommands.update({
		deepFilterNoiseSuppression: backend === 'deep_filter',
		noiseSuppression: backend === 'standard',
	});
}

export function isStereoMicrophoneChoiceAvailable(deviceLabel: string | null): boolean {
	const effective = readEffectiveNoiseSuppression(NOISE_SUPPRESSION_UI_SAMPLE_RATE);
	const profile = applyNoiseSuppressionOverride(
		resolveVoiceProcessingFromStateForDeviceLabel(VoiceSettings, deviceLabel),
		effective,
	);
	return supportsStereoCapture(profile);
}

export function isNoiseSuppressionAssignmentApplied(): boolean {
	return readEffectiveNoiseSuppression(NOISE_SUPPRESSION_UI_SAMPLE_RATE).rolloutApplied;
}

export function isAutoGainControlChoiceAvailable(deviceLabel: string | null): boolean {
	const effective = readEffectiveNoiseSuppression(NOISE_SUPPRESSION_UI_SAMPLE_RATE);
	const profile = resolveVoiceProcessingFromStateForDeviceLabel(VoiceSettings, deviceLabel);
	return !applyNoiseSuppressionOverride(
		{...profile, autoGainControl: false},
		{...effective, pipelineV2Enabled: effective.pipelineV2Enabled && !NoiseSuppressionAvailability.pipelineV2Failed},
	).pipelineV2Enabled;
}

export function isStereoMicrophoneEnabled(): boolean {
	return VoiceSettings.getStereoMicrophone() === true;
}
