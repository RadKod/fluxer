// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceProcessingMode} from '@app/features/voice/utils/VoiceProcessingProfile';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const settings = vi.hoisted(() => ({
	voiceProcessingMode: 'custom' as VoiceProcessingMode,
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
	deepFilterNoiseSuppression: true,
	deepFilterNoiseSuppressionLevel: 57,
	getNoiseSuppressionBackend: () => 'deep_filter',
	getStereoMicrophone: () => true,
}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: settings}));
vi.mock('@app/features/voice/engine/VoiceDevicePermissionState', () => ({
	default: {getState: () => ({inputDevices: []})},
}));
vi.mock('@app/features/voice/utils/VoiceDeviceManager', () => ({resolveEffectiveDeviceId: () => null}));

const rollout = vi.hoisted(() => ({
	assignment: {
		enabled: false,
		config_version: 0,
		user_targeted: false,
		backend: null,
		source: null,
		guild_overrides: [],
		enabled_backends: ['rnnoise', 'gate'],
		allow_user_override: false,
		suppression_strength: 80,
	},
}));
vi.mock('@app/features/voice/state/VoiceNoiseSuppressionRollout', () => ({default: rollout}));

const {default: availability} = await import('./NoiseSuppressionAvailability');
const runtime = await import('./NoiseSuppressionRuntime');
const selection = await import('./NoiseSuppressionSelection');
const {resolveRuntimeVoiceProcessing} = runtime;
const {resolveVoiceProcessing} = await import('@app/features/voice/utils/VoiceProcessingProfile');

describe('local noise suppression runtime', () => {
	beforeEach(() => {
		vi.stubGlobal('AudioWorkletNode', class {});
		rollout.assignment.enabled = false;
		availability.failures.clear();
		availability.setVoiceInputGraphUnavailable(false);
		availability.setDeepFilterAssetState('ready');
		availability.setInputContextRate(48000);
	});

	it('applies operator backend selection while retaining availability fallback', () => {
		Object.assign(rollout.assignment, {
			enabled: true,
			user_targeted: true,
			backend: 'rnnoise',
			source: 'user_rule',
			suppression_strength: 57,
		});
		const requested = resolveVoiceProcessing(settings);
		expect(resolveRuntimeVoiceProcessing(requested).noiseSuppressionBackend).toBe('rnnoise');
		availability.markBackendFailed('rnnoise', 'runtime', 0);
		expect(resolveRuntimeVoiceProcessing(requested).noiseSuppressionBackend).toBe('standard');
	});

	it.each([0, 57, 100])('passes operator strength %s to non-DeepFilter input graphs', (strength) => {
		Object.assign(rollout.assignment, {
			enabled: true,
			user_targeted: true,
			backend: 'gate',
			source: 'user_rule',
			suppression_strength: strength,
		});
		expect(runtime.readNoiseSuppressionStrength).toBeTypeOf('function');
		expect(runtime.readNoiseSuppressionStrength(resolveVoiceProcessing(settings, 'gate'))).toBe(strength);
	});

	it.each([
		{stereoPreferred: true, echoCancellation: false, autoGainControl: false, stereoCapture: true},
		{stereoPreferred: false, echoCancellation: false, autoGainControl: false, stereoCapture: false},
		{stereoPreferred: true, echoCancellation: true, autoGainControl: false, stereoCapture: false},
		{stereoPreferred: true, echoCancellation: false, autoGainControl: true, stereoCapture: false},
	])('derives operator-forced none stereo from the final pipeline: %j', (scenario) => {
		Object.assign(rollout.assignment, {
			enabled: true,
			user_targeted: true,
			backend: 'none',
			source: 'user_rule',
			enabled_backends: ['none'],
		});
		const {applyNoiseSuppressionOverride, resolveEffectiveNoiseSuppression} = selection;
		const profile = resolveVoiceProcessing({...settings, ...scenario}, 'rnnoise', scenario.stereoPreferred);
		expect(profile.stereoCapture).toBe(false);
		const effective = resolveEffectiveNoiseSuppression(
			rollout.assignment as unknown as Parameters<typeof resolveEffectiveNoiseSuppression>[0],
			null,
			'rnnoise',
			{sampleRate: 48000, wasmSimd: true, audioWorklet: true},
			scenario.stereoPreferred,
		);
		expect(applyNoiseSuppressionOverride(profile, effective)).toMatchObject({
			noiseSuppressionBackend: 'none',
			stereoCapture: scenario.stereoCapture,
		});
	});

	afterEach(() => {
		availability.failures.clear();
		vi.unstubAllGlobals();
	});

	it('preserves the explicit custom DeepFilter strength when the local backend is ready', () => {
		expect(resolveRuntimeVoiceProcessing(resolveVoiceProcessing(settings))).toMatchObject({
			noiseSuppressionBackend: 'deep_filter',
			deepFilter: true,
			deepFilterNoiseReductionLevel: 57,
			browserNoiseSuppression: false,
			stereoCapture: false,
		});
	});

	it('falls back to browser suppression while local assets load and recovers with the same strength', () => {
		const profile = resolveVoiceProcessing(settings);
		availability.setDeepFilterAssetState('loading');
		expect(resolveRuntimeVoiceProcessing(profile)).toMatchObject({
			noiseSuppressionBackend: 'standard',
			deepFilter: false,
			browserNoiseSuppression: true,
		});
		availability.setDeepFilterAssetState('ready');
		expect(resolveRuntimeVoiceProcessing(profile)).toMatchObject({
			noiseSuppressionBackend: 'deep_filter',
			deepFilterNoiseReductionLevel: 57,
		});
	});

	it('falls back after a runtime failure without changing the stored preference', () => {
		availability.markBackendFailed('deep_filter', 'runtime', 0);
		expect(resolveRuntimeVoiceProcessing(resolveVoiceProcessing(settings)).noiseSuppressionBackend).toBe('standard');
		expect(settings.getNoiseSuppressionBackend()).toBe('deep_filter');
		expect(settings.deepFilterNoiseSuppressionLevel).toBe(57);
	});

	it('keeps direct input stereo and free of processing even when the voice graph is unavailable', () => {
		Object.assign(rollout.assignment, {
			enabled: true,
			user_targeted: true,
			backend: 'gate',
			source: 'user_rule',
		});
		availability.setVoiceInputGraphUnavailable(true);
		expect(
			resolveRuntimeVoiceProcessing(resolveVoiceProcessing({...settings, voiceProcessingMode: 'studio'}, 'none', true)),
		).toMatchObject({
			noiseSuppressionBackend: 'none',
			deepFilter: false,
			echoCancellation: false,
			autoGainControl: false,
			browserNoiseSuppression: false,
			stereoCapture: true,
		});
	});
});
