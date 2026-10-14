// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createVoiceActivityGate, createVoiceSoftGain, loadVoiceActivityGate} from './VoiceActivityGate';
import {VOICE_PIPELINE_TUNING} from './VoicePipelineTuning';

afterEach(() => vi.unstubAllGlobals());

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		warn = vi.fn();
	},
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionWorkletAssets', () => ({
	VOICE_GATE_WORKLET_URL: 'gate.js',
	VOICE_VAD_WORKLET_URL: 'vad.js',
	VOICE_SOFT_GAIN_WORKLET_URL: 'gain.js',
}));

describe('voice detector loading', () => {
	it('passes the shared tuning to both raw worklets including the legacy gate', () => {
		const captured: Array<AudioWorkletNodeOptions> = [];
		vi.stubGlobal(
			'AudioWorkletNode',
			class {
				port = {onmessage: null};
				constructor(_context: AudioContext, _name: string, options: AudioWorkletNodeOptions) {
					captured.push(options);
				}
			},
		);
		const context = {} as AudioContext;
		createVoiceActivityGate(context, 1, {apply: true, auto: true, manualThresholdRms: 0.008}, vi.fn(), vi.fn());
		createVoiceSoftGain(context, vi.fn());
		expect(captured.map((options) => options.processorOptions.tuning)).toEqual([
			VOICE_PIPELINE_TUNING,
			VOICE_PIPELINE_TUNING,
		]);
		expect(captured[0].processorOptions.tuning.gateLookaheadMs).toBe(10);
	});
	it('downloads no VAD while disabled and loads it once when enabled later', async () => {
		const addModule = vi.fn().mockResolvedValue(undefined);
		const context = {audioWorklet: {addModule}, sampleRate: 48000} as unknown as AudioContext;
		const signal = new AbortController().signal;
		await loadVoiceActivityGate(context, signal);
		expect(addModule.mock.calls).toEqual([['gate.js']]);
		await loadVoiceActivityGate(context, signal, true);
		await loadVoiceActivityGate(context, signal, true);
		expect(addModule.mock.calls).toEqual([['gate.js'], ['vad.js']]);
	});
	it('keeps the RMS gate available after VAD download failure', async () => {
		const addModule = vi.fn(async (url: string) => {
			if (url === 'vad.js') throw new Error('network');
		});
		const context = {audioWorklet: {addModule}, sampleRate: 48000} as unknown as AudioContext;
		await expect(loadVoiceActivityGate(context, new AbortController().signal, true)).resolves.toBeUndefined();
	});
	it('never loads a 48kHz-only model at a different sample rate', async () => {
		const addModule = vi.fn().mockResolvedValue(undefined);
		const context = {audioWorklet: {addModule}, sampleRate: 44100} as unknown as AudioContext;
		await loadVoiceActivityGate(context, new AbortController().signal, true);
		expect(addModule.mock.calls).toEqual([['gate.js']]);
	});
});
