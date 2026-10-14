// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	applyNoiseSuppressionOverride,
	INERT_EFFECTIVE_NOISE_SUPPRESSION,
	resolveEffectiveNoiseSuppression,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionSelection';
import {VOICE_PIPELINE_TUNING} from '@app/features/voice/utils/VoicePipelineTuning';
import {resolveVoiceProcessing} from '@app/features/voice/utils/VoiceProcessingProfile';
import {INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT} from '@fluxer/schema/src/domains/admin/VoiceNoiseSuppressionSchemas';
import {describe, expect, it} from 'vitest';

const settings = {
	voiceProcessingMode: 'custom' as const,
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
	deepFilterNoiseSuppression: true,
	deepFilterNoiseSuppressionLevel: 57,
};

describe('Micup suppression contracts', () => {
	it('uses the schema pipeline scope even without a backend rollout target', () => {
		const assignment = {
			...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
			enabled: true,
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
		};
		const capabilities = {sampleRate: 48000, wasmSimd: true, audioWorklet: true};
		const effective = resolveEffectiveNoiseSuppression(assignment, null, null, capabilities);
		expect(effective.pipelineV2Enabled).toBe(true);
		expect(
			applyNoiseSuppressionOverride(resolveVoiceProcessing({...settings, autoGainControl: true}), effective),
		).toMatchObject({pipelineV2Enabled: true, autoGainControl: false});
		expect(
			resolveEffectiveNoiseSuppression(
				{
					...assignment,
					pipeline_v2_all: false,
					guild_overrides: [{guild_id: '123', backend: 'deep_filter', pipeline_v2: true}],
				},
				'123',
				null,
				capabilities,
			).pipelineV2Enabled,
		).toBe(true);
		expect(
			resolveEffectiveNoiseSuppression({...assignment, pipeline_v2_all: false}, '999', null, capabilities)
				.pipelineV2Enabled,
		).toBe(false);
	});
	it('resolves the admin pipeline tuning only while v2 applies to the call', () => {
		const assignment = {
			...INERT_VOICE_NOISE_SUPPRESSION_ASSIGNMENT,
			enabled: true,
			pipeline_v2_enabled: true,
			pipeline_v2_all: true,
			pipeline_v2_gain_max_db: 12,
			pipeline_v2_gate_hangover_ms: 700,
		};
		const capabilities = {sampleRate: 48000, wasmSimd: true, audioWorklet: true};
		const expected = {...VOICE_PIPELINE_TUNING, gainMaxDb: 12, gateHangoverMs: 700};
		expect(resolveEffectiveNoiseSuppression(assignment, null, null, capabilities).pipelineV2Tuning).toEqual(expected);
		expect(
			resolveEffectiveNoiseSuppression(
				{
					...assignment,
					pipeline_v2_all: false,
					guild_overrides: [{guild_id: '123', backend: 'deep_filter', pipeline_v2: true}],
				},
				'123',
				null,
				capabilities,
			).pipelineV2Tuning,
		).toEqual(expected);
		expect(
			resolveEffectiveNoiseSuppression({...assignment, pipeline_v2_enabled: false}, null, null, capabilities)
				.pipelineV2Tuning,
		).toBe(VOICE_PIPELINE_TUNING);
		expect(INERT_EFFECTIVE_NOISE_SUPPRESSION.pipelineV2Tuning).toBe(VOICE_PIPELINE_TUNING);
	});
	it('disables capture AGC for v2 while preserving the saved preference', () => {
		const saved = {...settings, autoGainControl: true};
		const effective = {
			...INERT_EFFECTIVE_NOISE_SUPPRESSION,
			rolloutApplied: true,
			backend: 'deep_filter' as const,
			pipelineV2Enabled: true,
		};
		const profile = applyNoiseSuppressionOverride(resolveVoiceProcessing(saved), effective);
		expect(profile.pipelineV2Enabled).toBe(true);
		expect(profile.autoGainControl).toBe(false);
		expect(saved.autoGainControl).toBe(true);
		expect(
			applyNoiseSuppressionOverride(resolveVoiceProcessing(saved), {...effective, pipelineV2Enabled: false})
				.autoGainControl,
		).toBe(true);
	});
	it('keeps studio and stereo out of v2', () => {
		const effective = {
			...INERT_EFFECTIVE_NOISE_SUPPRESSION,
			rolloutApplied: true,
			backend: 'none' as const,
			pipelineV2Enabled: true,
			stereoPreferred: true,
		};
		const mono = {...settings, deepFilterNoiseSuppression: false};
		expect(applyNoiseSuppressionOverride(resolveVoiceProcessing(mono), effective)).toMatchObject({
			stereoCapture: true,
			pipelineV2Enabled: false,
		});
		expect(
			applyNoiseSuppressionOverride(resolveVoiceProcessing({...mono, voiceProcessingMode: 'studio'}), effective)
				.pipelineV2Enabled,
		).toBe(false);
	});
	it.each([0, 57, 100])('preserves explicit custom strength %s', (strength) => {
		expect(
			resolveVoiceProcessing({...settings, deepFilterNoiseSuppressionLevel: strength}).deepFilterNoiseReductionLevel,
		).toBe(strength);
	});
	it('keeps studio free of suppression, echo cancellation and AGC', () => {
		expect(resolveVoiceProcessing({...settings, voiceProcessingMode: 'studio'})).toMatchObject({
			deepFilter: false,
			noiseSuppressionBackend: 'none',
			autoGainControl: false,
			echoCancellation: false,
		});
	});
	it('uses the local backend selection for a custom profile', () => {
		expect(resolveVoiceProcessing(settings, 'gate')).toMatchObject({
			noiseSuppressionBackend: 'gate',
			deepFilter: false,
			browserNoiseSuppression: false,
		});
	});
});
