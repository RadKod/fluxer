// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	detectWasmSimdSupport,
	getNoiseSuppressionBackendDescriptor,
	isVoiceNoiseSuppressionBackend,
	type NoiseSuppressionRuntimeCapabilities,
	selectUsableNoiseSuppressionBackend,
	type VoiceNoiseSuppressionBackend,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionBackends';
import {
	resolveVoicePipelineTuning,
	VOICE_PIPELINE_TUNING,
	type VoicePipelineTuning,
} from '@app/features/voice/utils/VoicePipelineTuning';
import type {ResolvedVoiceProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';
import {
	isVoicePipelineV2Active,
	resolveVoiceNoiseSuppressionForCall,
	type VoiceNoiseSuppressionAssignmentResponse,
	type VoiceNoiseSuppressionResolutionSource,
} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {observable, runInAction} from 'mobx';

export function readNoiseSuppressionRuntimeCapabilities(sampleRate = 48000): NoiseSuppressionRuntimeCapabilities {
	return {
		sampleRate,
		wasmSimd: detectWasmSimdSupport(),
		audioWorklet: typeof AudioWorkletNode === 'function',
	};
}

// Micup: with no saved choice the browser suppressor stays the default, not RNNoise.
export function resolveNoiseSuppressionBackend(preference: unknown): VoiceNoiseSuppressionBackend {
	return selectUsableNoiseSuppressionBackend(
		isVoiceNoiseSuppressionBackend(preference) ? preference : 'standard',
		readNoiseSuppressionRuntimeCapabilities(),
	);
}

export function supportsStereoCapture(profile: ResolvedVoiceProcessing): boolean {
	if (profile.echoCancellation || profile.autoGainControl) return false;
	if (profile.browserNoiseSuppression || profile.deepFilter) return false;
	return getNoiseSuppressionBackendDescriptor(profile.noiseSuppressionBackend).preservesInputChannels;
}

export function resolveStereoCapture(effective: EffectiveNoiseSuppression, profile: ResolvedVoiceProcessing): boolean {
	if (!supportsStereoCapture(profile)) return false;
	if (profile.mode === 'voice') return false;
	return effective.stereoPreferred;
}

export interface EffectiveNoiseSuppression {
	pipelineV2Enabled: boolean;
	pipelineV2Tuning: VoicePipelineTuning;
	rolloutApplied: boolean;
	backend: VoiceNoiseSuppressionBackend | null;
	requestedBackend: VoiceNoiseSuppressionBackend | null;
	source: VoiceNoiseSuppressionResolutionSource | null;
	suppressionStrength: number;
	stereoPreferred: boolean;
	configVersion: number;
}

export const INERT_EFFECTIVE_NOISE_SUPPRESSION: EffectiveNoiseSuppression = {
	pipelineV2Enabled: false,
	pipelineV2Tuning: VOICE_PIPELINE_TUNING,
	rolloutApplied: false,
	backend: null,
	requestedBackend: null,
	source: null,
	suppressionStrength: 80,
	stereoPreferred: false,
	configVersion: 0,
};

export function resolveEffectiveNoiseSuppression(
	assignment: VoiceNoiseSuppressionAssignmentResponse,
	guildId: string | null,
	userPreference: unknown,
	capabilities: NoiseSuppressionRuntimeCapabilities,
	stereoPreference: boolean | null = null,
): EffectiveNoiseSuppression {
	const preference = isVoiceNoiseSuppressionBackend(userPreference) ? userPreference : null;
	const resolution = resolveVoiceNoiseSuppressionForCall(assignment, guildId, preference);
	const stereoAllowed = stereoPreference === true;
	const pipelineV2Enabled = isVoicePipelineV2Active(assignment, guildId);
	const pipelineV2Tuning = pipelineV2Enabled ? resolveVoicePipelineTuning(assignment) : VOICE_PIPELINE_TUNING;
	if (resolution == null)
		return {
			...INERT_EFFECTIVE_NOISE_SUPPRESSION,
			stereoPreferred: stereoAllowed,
			pipelineV2Enabled,
			pipelineV2Tuning,
		};
	const backend = selectUsableNoiseSuppressionBackend(resolution.backend, capabilities);
	return {
		pipelineV2Enabled,
		pipelineV2Tuning,
		rolloutApplied: true,
		backend,
		requestedBackend: resolution.backend,
		source: resolution.source,
		suppressionStrength: resolution.suppressionStrength,
		stereoPreferred: stereoAllowed,
		configVersion: resolution.configVersion,
	};
}

const activeScopeGuildId = observable.box<string | null>(null);

export function setNoiseSuppressionScopeGuildId(guildId: string | null): void {
	runInAction(() => activeScopeGuildId.set(guildId));
}

export function getNoiseSuppressionScopeGuildId(): string | null {
	return activeScopeGuildId.get();
}

export function applyNoiseSuppressionOverride(
	profile: ResolvedVoiceProcessing,
	effective: EffectiveNoiseSuppression,
): ResolvedVoiceProcessing {
	if (!effective.rolloutApplied || effective.backend == null || profile.mode === 'studio') {
		const stereoCapture = resolveStereoCapture(effective, profile);
		const pipelineV2Enabled = effective.pipelineV2Enabled && profile.mode !== 'studio' && !stereoCapture;
		return {
			...profile,
			pipelineV2Enabled,
			stereoCapture,
			autoGainControl: pipelineV2Enabled ? false : profile.autoGainControl,
		};
	}
	const backend = effective.backend;
	const descriptor = getNoiseSuppressionBackendDescriptor(backend);
	const next = {
		...profile,
		browserNoiseSuppression: descriptor.browserNoiseSuppression,
		deepFilter: backend === 'deep_filter',
		deepFilterNoiseReductionLevel: backend === 'deep_filter' ? effective.suppressionStrength : 0,
		noiseSuppressionBackend: backend,
	};
	const stereoCapture = resolveStereoCapture(effective, next);
	const pipelineV2Enabled = effective.pipelineV2Enabled && !stereoCapture;
	return {...next, stereoCapture, pipelineV2Enabled, autoGainControl: pipelineV2Enabled ? false : next.autoGainControl};
}
