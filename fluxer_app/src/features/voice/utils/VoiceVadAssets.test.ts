// SPDX-License-Identifier: AGPL-3.0-or-later
import {webcrypto} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {expect, it} from 'vitest';
import {LOCAL_AUTO_MIN_RMS, LOCAL_MAX_RMS, SPEAKING_LOCAL_RELEASE_MS} from '../engine/VoiceSpeakingThreshold';
import {VOICE_PIPELINE_TUNING} from './VoicePipelineTuning';

it('rejects a changed model artifact at build time', () => {
	const require = createRequire(import.meta.url);
	const loader = require('../../../../scripts/build/rspack/voice-vad-worklet-loader.cjs');
	expect(() => loader('export default createRNNWasmModuleSync;')).toThrow('Unexpected');
});

it.skipIf(!process.env.VOICE_VAD_FIXTURE_ROOT)(
	'opens for recorded speech and keeps keyboard-only audio closed after real DeepFilter suppression',
	() => {
		const require = createRequire(import.meta.url);
		const loader = require('../../../../scripts/build/rspack/voice-vad-worklet-loader.cjs');
		const source = readFileSync(require.resolve('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'), 'utf8');
		const run = (file: string): number => {
			const wav = readFileSync(`${process.env.VOICE_VAD_FIXTURE_ROOT}/${file}`);
			let samples = new Float32Array();
			let format = 0;
			let bits = 0;
			for (let offset = 12; offset + 8 <= wav.length; ) {
				const name = wav.toString('ascii', offset, offset + 4);
				const size = wav.readUInt32LE(offset + 4);
				const start = offset + 8;
				if (name === 'fmt ') {
					format = wav.readUInt16LE(start);
					bits = wav.readUInt16LE(start + 14);
					expect(wav.readUInt16LE(start + 2)).toBe(1);
					expect(wav.readUInt32LE(start + 4)).toBe(48000);
				}
				if (name === 'data') {
					expect((format === 3 && bits === 32) || (format === 1 && bits === 16)).toBe(true);
					samples = Float32Array.from({length: size / (bits / 8)}, (_, i) =>
						format === 3 ? wav.readFloatLE(start + i * 4) : wav.readInt16LE(start + i * 2) / 32768,
					);
				}
				offset = start + size + (size % 2);
			}
			let Gate: new (
				options: object,
			) => {
				process(input: Array<Array<Float32Array>>, output: Array<Array<Float32Array>>): boolean;
				dispose?: () => void;
			};
			const context = {
				WebAssembly,
				atob,
				crypto: webcrypto,
				sampleRate: 48000,
				currentTime: 0,
				AudioWorkletProcessor: class {
					port = {
						postMessage: (message: {type: string; message?: string}) => {
							if (message.type === 'error' || message.type === 'vad-failure')
								throw new Error(message.message ?? message.type);
						},
						onmessage: null,
					};
				},
				registerProcessor: (_name: string, value: typeof Gate) => {
					Gate = value;
				},
			};
			runInNewContext(
				readFileSync(new URL('./noise_suppression/deepFilterProcessor.worklet.js', import.meta.url), 'utf8'),
				context,
			);
			const suppressor = new Gate!({
				processorOptions: {
					inputGain: 10,
					outputGain: 0.1,
					highPassHz: 60,
					attenLimDb: 80,
					wasmModule: new WebAssembly.Module(
						readFileSync(new URL('./noise_suppression/deepfilternet3/df_bg.wasm', import.meta.url)),
					),
					modelBytes: readFileSync(
						new URL('./noise_suppression/deepfilternet3/DeepFilterNet3_onnx.tar.gz', import.meta.url),
					),
				},
			});
			runInNewContext(loader(source).replace('import.meta.url', "'file:///vad.js'"), context);
			runInNewContext(readFileSync(new URL('./voiceGateProcessor.worklet.js', import.meta.url), 'utf8'), context);
			const gate = new Gate!({
				processorOptions: {
					tuning: VOICE_PIPELINE_TUNING,
					apply: true,
					auto: true,
					manualThresholdRms: 0.008,
					minRms: LOCAL_AUTO_MIN_RMS,
					maxRms: LOCAL_MAX_RMS,
					releaseMs: SPEAKING_LOCAL_RELEASE_MS,
					channelCount: 1,
					pipelineV2Enabled: true,
				},
			});
			let inputEnergy = 0;
			let outputEnergy = 0;
			for (let i = 0; i < samples.length; i += 128) {
				const input = new Float32Array(128);
				input.set(samples.subarray(i, i + 128));
				const output = new Float32Array(128);
				const suppressed = new Float32Array(128);
				suppressor.process([[input]], [[suppressed]]);
				gate.process([[suppressed]], [[output]]);
				for (let j = 0; j < 128; j++) {
					inputEnergy += suppressed[j] ** 2;
					outputEnergy += output[j] ** 2;
				}
			}
			suppressor.dispose?.();
			expect(inputEnergy).toBeGreaterThan(0);
			return outputEnergy / inputEnergy;
		};
		const speech = run('referans/common_voice_tr_17341269.wav');
		const keyboard = run('yalniz-gurultu/keyboard_mechanical-noise-only-1.wav');
		console.info({speechRetainedEnergy: speech, keyboardRetainedEnergy: keyboard});
		expect(speech).toBeGreaterThan(0.5);
		expect(keyboard).toBe(0);
	},
	30000,
);

it('loads the packaged synchronous RNNoise WASM without browser networking', () => {
	const require = createRequire(import.meta.url);
	const loader = require('../../../../scripts/build/rspack/voice-vad-worklet-loader.cjs');
	const source = readFileSync(require.resolve('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'), 'utf8');
	const context = {
		fluxerCreateVoiceVad: undefined as unknown as () => {
			HEAPF32: Float32Array;
			_malloc(size: number): number;
			_free(ptr: number): void;
			_rnnoise_create(model: number): number;
			_rnnoise_destroy(state: number): void;
			_rnnoise_process_frame(state: number, output: number, input: number): number;
		},
		WebAssembly,
		atob,
	};
	runInNewContext(loader(source).replace('import.meta.url', "'file:///vad.js'"), context);
	const wasm = context.fluxerCreateVoiceVad();
	const state = wasm._rnnoise_create(0);
	const ptr = wasm._malloc(480 * 4);
	let probability = 1;
	for (let frame = 0; frame < 100; frame++) {
		for (let i = 0; i < 480; i++) {
			// A deterministic decaying broadband key strike every 100ms.
			wasm.HEAPF32[ptr / 4 + i] = frame % 10 === 0 ? Math.sin(i * i) * Math.exp(-i / 40) * 8000 : 0;
		}
		probability = wasm._rnnoise_process_frame(state, ptr, ptr);
		expect(Number.isFinite(probability)).toBe(true);
	}
	expect(probability).toBeLessThan(0.6);
	wasm._free(ptr);
	wasm._rnnoise_destroy(state);
});
