// SPDX-License-Identifier: AGPL-3.0-or-later

import {INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {observable, runInAction} from 'mobx';
import {afterEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({prefetch: vi.fn()}));
vi.mock('@app/features/voice/state/VoiceNoiseSuppressionRollout', () => ({
	default: {
		get assignment() {
			return state.assignment;
		},
	},
}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({
	default: {
		getNoiseSuppressionBackend: () => null,
		getStereoMicrophone: () => false,
		getVoiceProcessingModeForDeviceLabel: () => 'custom',
		getEchoCancellation: () => false,
		getAutoGainControl: () => true,
		getNoiseSuppression: () => true,
		getDeepFilterNoiseSuppression: () => false,
		getDeepFilterNoiseSuppressionLevel: () => 80,
	},
}));
vi.mock('@app/features/voice/utils/VoiceProcessingProfile', () => ({
	getActiveInputDeviceLabel: () => '',
	getActiveVoiceProcessingMode: () => 'custom',
	resolveVoiceProcessing: (settings: object) => ({
		...settings,
		mode: 'custom',
		noiseSuppressionBackend: 'standard',
		stereoCapture: false,
		autoGainControl: true,
	}),
	resolveVoiceProcessingFromStateForDeviceLabel: () => ({
		mode: 'custom',
		noiseSuppressionBackend: 'standard',
		stereoCapture: false,
		autoGainControl: true,
	}),
}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({prefetchDeepFilterAssets: mocks.prefetch}));

import type {ResolvedVoiceProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';
import Availability from './NoiseSuppressionAvailability';
import {bindVoicePipelineV2Prefetch, resolveRuntimeVoiceProcessing} from './NoiseSuppressionRuntime';
import {setNoiseSuppressionScopeGuildId} from './NoiseSuppressionSelection';

const state = observable({assignment: {...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT}});

afterEach(() => {
	setNoiseSuppressionScopeGuildId(null);
	mocks.prefetch.mockClear();
	vi.unstubAllGlobals();
});

describe('pipeline asset prefetch', () => {
	it('restores saved AGC when pipeline gain fails and keeps the rollback on capture restart', () => {
		runInAction(() => {
			state.assignment = {
				...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
				enabled: true,
				pipeline_v2_enabled: true,
				pipeline_v2_all: true,
			};
		});
		const saved: ResolvedVoiceProcessing = {
			pipelineV2Enabled: false,
			mode: 'custom',
			echoCancellation: false,
			browserNoiseSuppression: true,
			autoGainControl: true,
			deepFilter: false,
			deepFilterNoiseReductionLevel: 0,
			contentHint: '',
			noiseSuppressionBackend: 'standard',
			stereoCapture: false,
		};
		expect(resolveRuntimeVoiceProcessing(saved)).toMatchObject({pipelineV2Enabled: true, autoGainControl: false});
		try {
			Availability.markPipelineV2Failed();
			Availability.releaseExpiredFailures(Date.now());
			expect(resolveRuntimeVoiceProcessing(saved)).toMatchObject({pipelineV2Enabled: false, autoGainControl: true});
			expect(saved.autoGainControl).toBe(true);
		} finally {
			Availability.releaseExpiredFailures(Date.now(), true);
		}
	});
	it('waits for a running microphone graph before prefetching an app-wide DeepFilter assignment', async () => {
		vi.stubGlobal('AudioWorkletNode', class {});
		const owner = {};
		const dispose = bindVoicePipelineV2Prefetch();
		try {
			runInAction(() => {
				state.assignment = {
					...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
					enabled: true,
					pipeline_v2_enabled: true,
					pipeline_v2_all: true,
					user_targeted: true,
					backend: 'deep_filter',
					source: 'canary',
					enabled_backends: ['deep_filter'],
				};
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(mocks.prefetch).not.toHaveBeenCalled();
			Availability.setVoiceInputRuntime(owner, 'standard', {}, null);
			await vi.waitFor(() => expect(mocks.prefetch).toHaveBeenCalledOnce());
			Availability.clearVoiceInputRuntime(owner);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(mocks.prefetch).toHaveBeenCalledOnce();
		} finally {
			Availability.clearVoiceInputRuntime(owner);
			dispose();
		}
	});
	it('prefetches a late guild assignment while a microphone graph runs, only while v2 is active', async () => {
		vi.stubGlobal('AudioWorkletNode', class {});
		const owner = {};
		Availability.setVoiceInputRuntime(owner, 'standard', {}, null);
		const dispose = bindVoicePipelineV2Prefetch();
		try {
			runInAction(() => {
				state.assignment = {
					...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
					enabled: true,
					pipeline_v2_enabled: true,
					guild_overrides: [{guild_id: '123', backend: 'deep_filter', pipeline_v2: true}],
				};
			});
			await vi.waitFor(() => expect(mocks.prefetch).not.toHaveBeenCalled());
			setNoiseSuppressionScopeGuildId('123');
			await vi.waitFor(() => expect(mocks.prefetch).toHaveBeenCalledOnce());
			setNoiseSuppressionScopeGuildId('999');
			await Promise.resolve();
			expect(mocks.prefetch).toHaveBeenCalledOnce();
		} finally {
			Availability.clearVoiceInputRuntime(owner);
			dispose();
		}
	});
});
