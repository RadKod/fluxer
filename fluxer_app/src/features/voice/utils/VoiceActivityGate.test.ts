// SPDX-License-Identifier: AGPL-3.0-or-later

import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';
import {VOICE_PIPELINE_TUNING} from './VoicePipelineTuning';

interface GateProcessor {
	process(inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean;
	port: {onmessage: (event: {data: Record<string, unknown>}) => void};
}

function createGate(apply = true, probability?: () => number): GateProcessor {
	const file = fileURLToPath(new URL('./voiceGateProcessor.worklet.js', import.meta.url));
	expect(existsSync(file), 'voice gate must run on the audio rendering clock').toBe(true);
	let Gate: new (options: object) => GateProcessor;
	runInNewContext(readFileSync(file, 'utf8'), {
		sampleRate: 48000,
		currentTime: 0,
		fluxerCreateVoiceVad: probability
			? () => ({
					HEAPF32: new Float32Array(481),
					_malloc: () => 4,
					_free: () => {},
					_rnnoise_create: () => 1,
					_rnnoise_destroy: () => {},
					_rnnoise_process_frame: probability,
				})
			: undefined,
		AudioWorkletProcessor: class {
			port = {postMessage: vi.fn(), onmessage: null};
		},
		registerProcessor: (_name: string, processor: typeof Gate) => {
			Gate = processor;
		},
		// Main-thread timers never advance during these audio render quanta.
		setTimeout: () => {
			throw new Error('audio gate depends on a main-thread timer');
		},
		setInterval: () => {
			throw new Error('audio gate depends on a main-thread timer');
		},
	});
	return new Gate!({
		processorOptions: {
			tuning: VOICE_PIPELINE_TUNING,
			apply,
			pipelineV2Enabled: probability !== undefined,
			auto: false,
			manualThresholdRms: 0.008,
			minRms: 0.003,
			maxRms: 0.04,
			releaseMs: 180,
			channelCount: 1,
		},
	});
}

function render(gate: GateProcessor, amplitude: number, frames: number): number {
	let energy = 0;
	for (let frame = 0; frame < frames; frame += 128) {
		const input = Float32Array.from(
			{length: 128},
			(_, i) => amplitude * Math.sin((2 * Math.PI * 440 * (frame + i)) / 48000),
		);
		const output = new Float32Array(128);
		expect(gate.process([[input]], [[output]])).toBe(true);
		for (const sample of output) energy += sample * sample;
	}
	return energy;
}

describe('voice activity gate audio clock', () => {
	it('rejects energetic non-speech and uses probability hysteresis and 400ms hangover', () => {
		let probability = 0.59;
		const gate = createGate(true, () => probability);
		expect(render(gate, 0.1, 24000)).toBeLessThan(1e-8);
		probability = 0.6;
		expect(render(gate, 0.1, 4800)).toBeGreaterThan(10);
		probability = 0.35;
		expect(render(gate, 0.1, 24000)).toBeGreaterThan(100);
		probability = 0.34;
		expect(render(gate, 0.1, 14400)).toBeGreaterThan(50);
		render(gate, 0.1, 14400);
		expect(render(gate, 0.1, 4800)).toBeLessThan(1e-6);
	});
	it('applies live tuning from a config message to the running detector', () => {
		let probability = 0.7;
		const gate = createGate(true, () => probability);
		gate.port.onmessage({
			data: {
				type: 'config',
				apply: true,
				auto: false,
				manualThresholdRms: 0.008,
				pipelineV2Enabled: true,
				tuning: {...VOICE_PIPELINE_TUNING, gateOpenProbability: 0.8, gateRefreshProbability: 0.5, gateHangoverMs: 100},
			},
		});
		expect(render(gate, 0.1, 24000)).toBeLessThan(1e-8);
		probability = 0.8;
		expect(render(gate, 0.1, 4800)).toBeGreaterThan(10);
		probability = 0.49;
		render(gate, 0.1, 14400);
		expect(render(gate, 0.1, 4800)).toBeLessThan(1e-6);
	});
	it('falls back to the RMS gate on a VAD runtime exception and preserves push to talk', () => {
		const gate = createGate(true, () => {
			throw new Error('wasm failed');
		});
		expect(render(gate, 0.1, 14400)).toBeGreaterThan(60);
		expect(
			render(
				createGate(false, () => 0),
				0.001,
				14400,
			),
		).toBeGreaterThan(0.006);
	});
	it('returns to RMS behavior when the pipeline is switched off', () => {
		const gate = createGate(true, () => 0);
		expect(render(gate, 0.1, 4800)).toBeLessThan(1e-8);
		gate.port.onmessage({
			data: {type: 'config', apply: true, auto: false, manualThresholdRms: 0.008, pipelineV2Enabled: false},
		});
		expect(render(gate, 0.1, 14400)).toBeGreaterThan(60);
	});
	it('keeps the RMS fallback for the session after the VAD exceeds its CPU budget', () => {
		const gate = createGate(true, () => 0);
		gate.port.onmessage({data: {type: 'disable-vad'}});
		gate.port.onmessage({
			data: {type: 'config', apply: true, auto: false, manualThresholdRms: 0.008, pipelineV2Enabled: true},
		});
		expect(render(gate, 0.1, 14400)).toBeGreaterThan(60);
	});
	it('falls back on an invalid probability and requires energy as well as probability', () => {
		expect(
			render(
				createGate(true, () => Number.NaN),
				0.1,
				14400,
			),
		).toBeGreaterThan(60);
		expect(
			render(
				createGate(true, () => 0.9),
				0.001,
				14400,
			),
		).toBeLessThan(1e-8);
	});
	it('passes a 300 ms syllable while main-thread timers stay frozen', () => {
		const gate = createGate();
		render(gate, 0, 24000);
		const energy = render(gate, 0.1, 14400);
		expect(energy).toBeGreaterThan(60);
	});
	it('closes below threshold after the release using rendered samples', () => {
		const gate = createGate();
		render(gate, 0.1, 14400);
		render(gate, 0.001, 24000);
		expect(render(gate, 0.001, 4800)).toBeLessThan(1e-8);
	});
	it('preserves quiet audio when gating is bypassed', () => {
		const gate = createGate(false);
		expect(render(gate, 0.001, 14400)).toBeGreaterThan(0.006);
	});
});
