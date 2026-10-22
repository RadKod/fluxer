// SPDX-License-Identifier: AGPL-3.0-or-later

import VoiceDevicePermissionState from '@app/features/voice/engine/VoiceDevicePermissionState';
import type VoiceSettings from '@app/features/voice/state/VoiceSettings';
import {
	getNoiseSuppressionBackendDescriptor,
	type VoiceNoiseSuppressionBackend,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionBackends';
import {
	resolveNoiseSuppressionBackend,
	supportsStereoCapture,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionSelection';
import {resolveEffectiveDeviceId} from '@app/features/voice/utils/VoiceDeviceManager';

export type VoiceProcessingMode = 'voice' | 'studio' | 'custom';

export interface VoiceProcessingSettingsLike {
	voiceProcessingMode: VoiceProcessingMode;
	echoCancellation: boolean;
	noiseSuppression?: boolean;
	autoGainControl: boolean;
	deepFilterNoiseSuppression?: boolean;
	deepFilterNoiseSuppressionLevel?: number;
}

export interface ResolvedVoiceProcessing {
	pipelineV2Enabled: boolean;
	mode: VoiceProcessingMode;
	echoCancellation: boolean;
	browserNoiseSuppression: boolean;
	autoGainControl: boolean;
	deepFilter: boolean;
	deepFilterNoiseReductionLevel: number;
	contentHint: '' | 'speech' | 'music';
	noiseSuppressionBackend: VoiceNoiseSuppressionBackend;
	stereoCapture: boolean;
}

export function legacyNoiseSuppressionBackend(
	deepFilter: boolean,
	browserNoiseSuppression: boolean,
): VoiceNoiseSuppressionBackend {
	if (deepFilter) return 'deep_filter';
	if (browserNoiseSuppression) return 'standard';
	return 'none';
}

export const DEFAULT_VOICE_PROCESSING_MODE: VoiceProcessingMode = 'voice';
export const DEEP_FILTER_NOISE_REDUCTION_LEVEL_MIN = 0;
export const DEEP_FILTER_NOISE_REDUCTION_LEVEL_MAX = 100;

export function clampDeepFilterNoiseReductionLevel(level: number): number {
	if (!Number.isFinite(level)) {
		return DEEP_FILTER_NOISE_REDUCTION_LEVEL_MAX;
	}
	return Math.min(DEEP_FILTER_NOISE_REDUCTION_LEVEL_MAX, Math.max(DEEP_FILTER_NOISE_REDUCTION_LEVEL_MIN, level));
}

export function resolveVoiceProcessing(
	settings: VoiceProcessingSettingsLike,
	backend: VoiceNoiseSuppressionBackend = settings.deepFilterNoiseSuppression
		? 'deep_filter'
		: settings.noiseSuppression === false
			? 'none'
			: resolveNoiseSuppressionBackend(null),
	stereoPreferred = false,
): ResolvedVoiceProcessing {
	const profile = resolveBaseVoiceProcessing(settings, backend);
	return {...profile, stereoCapture: profile.mode !== 'voice' && stereoPreferred && supportsStereoCapture(profile)};
}

function resolveBaseVoiceProcessing(
	settings: VoiceProcessingSettingsLike,
	backend: VoiceNoiseSuppressionBackend,
): ResolvedVoiceProcessing {
	switch (settings.voiceProcessingMode) {
		case 'studio':
			return {
				pipelineV2Enabled: false,
				mode: 'studio',
				echoCancellation: false,
				browserNoiseSuppression: false,
				autoGainControl: false,
				deepFilter: false,
				deepFilterNoiseReductionLevel: DEEP_FILTER_NOISE_REDUCTION_LEVEL_MIN,
				contentHint: 'music',
				noiseSuppressionBackend: 'none',
				stereoCapture: false,
			};
		case 'custom': {
			const browserNs = getNoiseSuppressionBackendDescriptor(backend).browserNoiseSuppression;
			return {
				pipelineV2Enabled: false,
				mode: 'custom',
				echoCancellation: settings.echoCancellation,
				browserNoiseSuppression: browserNs,
				autoGainControl: settings.autoGainControl,
				deepFilter: backend === 'deep_filter',
				deepFilterNoiseReductionLevel:
					backend === 'deep_filter'
						? clampDeepFilterNoiseReductionLevel(settings.deepFilterNoiseSuppressionLevel ?? 30)
						: DEEP_FILTER_NOISE_REDUCTION_LEVEL_MIN,
				contentHint: '',
				noiseSuppressionBackend: backend,
				stereoCapture: false,
			};
		}
		default:
			return {
				pipelineV2Enabled: false,
				mode: 'voice',
				echoCancellation: true,
				browserNoiseSuppression: getNoiseSuppressionBackendDescriptor(resolveNoiseSuppressionBackend(null))
					.browserNoiseSuppression,
				autoGainControl: settings.autoGainControl,
				deepFilter: false,
				deepFilterNoiseReductionLevel: DEEP_FILTER_NOISE_REDUCTION_LEVEL_MIN,
				contentHint: '',
				noiseSuppressionBackend: resolveNoiseSuppressionBackend(null),
				stereoCapture: false,
			};
	}
}

// How someone singing over music hears it. With headphones the mic picks up only the voice; on speakers it also
// picks up the music and needs echo cancellation.
export type VoiceMusicProcessing = 'headphones' | 'speakers';

// A voice over music: noise suppression treats held notes as noise, gain control and the leveller pump against the
// music, and the gate cuts soft passages, so all of them stay off; the input takes the direct path like studio. On
// speakers echo cancellation stays on. Stereo capture is left as it was: changing it re-publishes the mic.
export function applyMusicProcessing(
	profile: ResolvedVoiceProcessing,
	music: VoiceMusicProcessing,
): ResolvedVoiceProcessing {
	return {
		...profile,
		pipelineV2Enabled: false,
		mode: 'studio',
		echoCancellation: music === 'speakers',
		browserNoiseSuppression: false,
		autoGainControl: false,
		deepFilter: false,
		deepFilterNoiseReductionLevel: DEEP_FILTER_NOISE_REDUCTION_LEVEL_MIN,
		contentHint: 'music',
		noiseSuppressionBackend: 'none',
	};
}

export function resolveVoiceProcessingFromStateForDeviceLabel(
	store: typeof VoiceSettings,
	label: string | null | undefined,
): ResolvedVoiceProcessing {
	return resolveVoiceProcessing(
		{
			voiceProcessingMode: store.getVoiceProcessingModeForDeviceLabel(label),
			echoCancellation: store.echoCancellation,
			noiseSuppression: store.noiseSuppression,
			autoGainControl: store.autoGainControl,
			deepFilterNoiseSuppression: store.deepFilterNoiseSuppression,
			deepFilterNoiseSuppressionLevel: store.deepFilterNoiseSuppressionLevel,
		},
		resolveNoiseSuppressionBackend(
			store.getNoiseSuppressionBackend() ??
				(store.deepFilterNoiseSuppression ? 'deep_filter' : !store.noiseSuppression ? 'none' : null),
		),
		store.getStereoMicrophone() === true,
	);
}

export function getActiveInputDeviceLabel(store: typeof VoiceSettings): string | null {
	const {inputDevices} = VoiceDevicePermissionState.getState();
	const effectiveId = resolveEffectiveDeviceId(store.inputDeviceId, inputDevices);
	if (!effectiveId) return null;
	const device = inputDevices.find((d) => d.deviceId === effectiveId);
	return device?.label || null;
}

export function getActiveVoiceProcessingMode(store: typeof VoiceSettings): VoiceProcessingMode {
	return store.getVoiceProcessingModeForDeviceLabel(getActiveInputDeviceLabel(store));
}

export function applyContentHintToTrack(track: MediaStreamTrack, hint: '' | 'speech' | 'music'): void {
	try {
		(
			track as MediaStreamTrack & {
				contentHint?: string;
			}
		).contentHint = hint;
	} catch {}
}
