// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceNoiseSuppressionBackend} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionBackends';
import type {I18n, MessageDescriptor} from '@lingui/core';
import {beforeEach, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	pipelineV2Enabled: true,
	requested: 'deep_filter' as VoiceNoiseSuppressionBackend,
	runningBackend: 'standard' as VoiceNoiseSuppressionBackend | null,
	fallback: null as 'loading' | 'failed' | 'cpu_budget' | null,
}));

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: MessageDescriptor) => descriptor}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability', () => ({
	default: {
		get runningBackend() {
			return state.runningBackend;
		},
		getFallback: () => state.fallback,
	},
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', () => ({
	readVoicePipelineV2Enabled: () => state.pipelineV2Enabled,
	readRequestedNoiseSuppressionBackend: () => state.requested,
	readEffectiveNoiseSuppressionBackend: () => state.runningBackend ?? 'deep_filter',
}));

import {getNoiseSuppressionFallbackMessage} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionLabels';

const i18n = {_: (descriptor: MessageDescriptor) => descriptor.message} as I18n;

beforeEach(() => {
	state.pipelineV2Enabled = true;
	state.requested = 'deep_filter';
	state.runningBackend = 'standard';
	state.fallback = null;
});

it('reports the running slot while a ready model is still being installed', () => {
	expect(getNoiseSuppressionFallbackMessage(i18n)).toBe('Running filter: WebRTC. Requested: DeepFilterNet. Loading.');
});

it('reports the actual filter after the slot switches', () => {
	state.runningBackend = 'deep_filter';
	expect(getNoiseSuppressionFallbackMessage(i18n)).toBe('Running filter: DeepFilterNet. Requested: DeepFilterNet.');
});

it('does not present an effective preference as a running microphone', () => {
	state.runningBackend = null;
	expect(getNoiseSuppressionFallbackMessage(i18n)).toBe('Microphone inactive. Requested filter: DeepFilterNet.');
});

it.each([
	['loading', 'Loading.'],
	['failed', 'The requested filter could not start.'],
	['cpu_budget', 'Switched filters because of processor load.'],
] as const)('shows the %s fallback reason', (fallback, reason) => {
	state.fallback = fallback;
	expect(getNoiseSuppressionFallbackMessage(i18n)).toBe(`Running filter: WebRTC. Requested: DeepFilterNet. ${reason}`);
});

it('preserves the existing message when the pipeline is disabled', () => {
	state.pipelineV2Enabled = false;
	expect(getNoiseSuppressionFallbackMessage(i18n)).toBeNull();
	state.fallback = 'loading';
	expect(getNoiseSuppressionFallbackMessage(i18n)).toBe('Using WebRTC until DeepFilterNet is ready.');
	state.fallback = 'failed';
	expect(getNoiseSuppressionFallbackMessage(i18n)).toBe('DeepFilterNet could not start. Using WebRTC instead.');
});
