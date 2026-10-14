// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/features/platform/utils/AppLogger';
import VoiceNoiseSuppressionRollout from '@app/features/voice/state/VoiceNoiseSuppressionRollout';
import VoiceSettings from '@app/features/voice/state/VoiceSettings';
import NoiseSuppressionAvailability from '@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability';
import type {VoiceNoiseSuppressionBackend} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionBackends';
import {
	applyNoiseSuppressionOverride,
	getNoiseSuppressionScopeGuildId,
	readNoiseSuppressionRuntimeCapabilities,
	resolveEffectiveNoiseSuppression,
	resolveNoiseSuppressionBackend,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionSelection';
import {
	getActiveInputDeviceLabel,
	type ResolvedVoiceProcessing,
	resolveVoiceProcessing,
	resolveVoiceProcessingFromStateForDeviceLabel,
} from '@app/features/voice/utils/VoiceProcessingProfile';
import {reaction} from 'mobx';

export function resolveRuntimeVoiceProcessing(profile: ResolvedVoiceProcessing): ResolvedVoiceProcessing {
	const effective = readEffectiveNoiseSuppression(48000);
	const requested = applyNoiseSuppressionOverride(profile, {
		...effective,
		pipelineV2Enabled: effective.pipelineV2Enabled && !NoiseSuppressionAvailability.pipelineV2Failed,
	});
	const backend = NoiseSuppressionAvailability.resolveEffectiveBackend(
		requested.noiseSuppressionBackend,
		requested.pipelineV2Enabled,
	);
	return {
		...requested,
		noiseSuppressionBackend: backend,
		deepFilter: backend === 'deep_filter',
		browserNoiseSuppression: backend === 'standard',
	};
}

export function readVoicePipelineV2Enabled(): boolean {
	return resolveRuntimeVoiceProcessing(
		resolveVoiceProcessingFromStateForDeviceLabel(VoiceSettings, getActiveInputDeviceLabel(VoiceSettings)),
	).pipelineV2Enabled;
}

export function bindVoicePipelineV2Prefetch(): () => void {
	// Only while a microphone graph runs: an app-wide assignment must not pin the DeepFilter assets in idle clients.
	const shouldPrefetch = () =>
		NoiseSuppressionAvailability.runningBackend !== null &&
		readVoicePipelineV2Enabled() &&
		readRequestedNoiseSuppressionBackend() === 'deep_filter';
	return reaction(
		shouldPrefetch,
		(enabled) => {
			if (!enabled) return;
			void import('@app/features/voice/utils/noise_suppression/DeepFilter')
				.then((module) => {
					if (shouldPrefetch()) module.prefetchDeepFilterAssets();
				})
				.catch((error: unknown) => {
					new Logger('NoiseSuppressionRuntime').warn('Failed to load noise suppression prefetch module', {error});
					NoiseSuppressionAvailability.markBackendFailed('deep_filter', 'assets', Date.now());
				});
		},
		{fireImmediately: true},
	);
}

export function readEffectiveNoiseSuppression(sampleRate: number) {
	return resolveEffectiveNoiseSuppression(
		VoiceNoiseSuppressionRollout.assignment,
		getNoiseSuppressionScopeGuildId(),
		VoiceSettings.getNoiseSuppressionBackend(),
		readNoiseSuppressionRuntimeCapabilities(sampleRate),
		VoiceSettings.getStereoMicrophone(),
	);
}

export function readNoiseSuppressionStrength(profile: ResolvedVoiceProcessing): number {
	const effective = readEffectiveNoiseSuppression(48000);
	if (effective.rolloutApplied && profile.mode !== 'studio') return effective.suppressionStrength;
	return profile.deepFilter ? profile.deepFilterNoiseReductionLevel : 80;
}

export function readNoiseSuppressionBackend(): VoiceNoiseSuppressionBackend {
	return resolveNoiseSuppressionBackend(
		VoiceSettings.getNoiseSuppressionBackend() ??
			(VoiceSettings.getDeepFilterNoiseSuppression()
				? 'deep_filter'
				: !VoiceSettings.getNoiseSuppression()
					? 'none'
					: null),
	);
}

export function readRequestedNoiseSuppressionBackend(): VoiceNoiseSuppressionBackend {
	const profile = resolveVoiceProcessing(
		{
			voiceProcessingMode: VoiceSettings.getVoiceProcessingModeForDeviceLabel(getActiveInputDeviceLabel(VoiceSettings)),
			echoCancellation: VoiceSettings.getEchoCancellation(),
			autoGainControl: VoiceSettings.getAutoGainControl(),
			noiseSuppression: VoiceSettings.getNoiseSuppression(),
			deepFilterNoiseSuppression: VoiceSettings.getDeepFilterNoiseSuppression(),
			deepFilterNoiseSuppressionLevel: VoiceSettings.getDeepFilterNoiseSuppressionLevel(),
		},
		readNoiseSuppressionBackend(),
	);
	return applyNoiseSuppressionOverride(profile, readEffectiveNoiseSuppression(48000)).noiseSuppressionBackend;
}

export function readEffectiveNoiseSuppressionBackend(): VoiceNoiseSuppressionBackend {
	return (
		NoiseSuppressionAvailability.runningBackend ??
		resolveRuntimeVoiceProcessing(
			resolveVoiceProcessingFromStateForDeviceLabel(VoiceSettings, getActiveInputDeviceLabel(VoiceSettings)),
		).noiseSuppressionBackend
	);
}

export function readVoiceInputDiagnostics() {
	const profile = resolveRuntimeVoiceProcessing(
		resolveVoiceProcessingFromStateForDeviceLabel(VoiceSettings, getActiveInputDeviceLabel(VoiceSettings)),
	);
	const capture = NoiseSuppressionAvailability.captureSettings;
	return {
		echoCancellation:
			capture?.echoCancellation === undefined ? profile.echoCancellation : Boolean(capture.echoCancellation),
		browserNoiseSuppression: capture?.noiseSuppression ?? profile.browserNoiseSuppression,
		noiseSuppression: capture?.noiseSuppression ?? profile.browserNoiseSuppression,
		deepFilterNoiseSuppression: profile.deepFilter,
		deepFilterNoiseSuppressionLevel: profile.deepFilterNoiseReductionLevel,
		autoGainControl: capture?.autoGainControl ?? profile.autoGainControl,
		noiseSuppressionBackend: readEffectiveNoiseSuppressionBackend(),
		requestedNoiseSuppressionBackend: readRequestedNoiseSuppressionBackend(),
		processingMode: profile.mode,
		pipelineV2Enabled: profile.pipelineV2Enabled,
		voiceInputGraphUnavailable: NoiseSuppressionAvailability.voiceInputGraphUnavailable,
		deepFilterLevels: NoiseSuppressionAvailability.deepFilterLevels,
	};
}

export function readCaptureNoiseSuppressionBackend(track: MediaStreamTrack): 'standard' | 'none' {
	const actual = track.getSettings().noiseSuppression;
	if (actual !== undefined) return actual ? 'standard' : 'none';
	const constraint = track.getConstraints().noiseSuppression;
	const enabled = typeof constraint === 'object' ? (constraint.exact ?? constraint.ideal) : constraint;
	return enabled === true ? 'standard' : 'none';
}
