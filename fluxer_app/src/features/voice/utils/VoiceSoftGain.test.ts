// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {expect, it, vi} from 'vitest';
import {VOICE_PIPELINE_TUNING} from './VoicePipelineTuning';

it('reports cumulative gain processing time only for the active v2 route', () => {
	let Processor: new (
		options: object,
	) => {
		process(inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean;
		port: {onmessage: (event: {data: object}) => void};
	};
	const reports: Array<{processingMs: number; audioMs: number}> = [];
	let clock = 0;
	const now = vi.fn(() => ++clock);
	runInNewContext(readFileSync(new URL('./voiceSoftGain.worklet.js', import.meta.url), 'utf8'), {
		sampleRate: 48000,
		currentTime: 0,
		Date: {now},
		AudioWorkletProcessor: class {
			port = {
				onmessage: null,
				postMessage: (message: {processingMs: number; audioMs: number}) => reports.push(message),
			};
		},
		registerProcessor: (_name: string, value: typeof Processor) => {
			Processor = value;
		},
	});
	const node = new Processor!({processorOptions: {tuning: VOICE_PIPELINE_TUNING}});
	const input = new Float32Array(128).fill(0.01);
	const output = new Float32Array(128);
	const render = () => {
		for (let i = 0; i < 200; i++) node.process([[input]], [[output]]);
	};
	render();
	expect(now).not.toHaveBeenCalled();
	node.port.onmessage({data: {type: 'configure-health', enabled: true}});
	render();
	expect(reports).toHaveLength(1);
	expect(reports[0].processingMs).toBeGreaterThan(0);
	expect(reports[0].audioMs).toBeGreaterThanOrEqual(500);
	node.port.onmessage({data: {type: 'configure-health', enabled: false}});
	now.mockClear();
	render();
	expect(now).not.toHaveBeenCalled();
	expect(reports).toHaveLength(1);
});

it('learns only during speech, limits rise to 6dB/s and caps gain at 20dB', () => {
	let Processor: new (
		options: object,
	) => {
		process(inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean;
	};
	runInNewContext(readFileSync(new URL('./voiceSoftGain.worklet.js', import.meta.url), 'utf8'), {
		sampleRate: 48000,
		AudioWorkletProcessor: class {
			port = {onmessage: null};
		},
		registerProcessor: (_name: string, value: typeof Processor) => {
			Processor = value;
		},
	});
	const node = new Processor!({processorOptions: {tuning: VOICE_PIPELINE_TUNING}});
	const input = new Float32Array(128).fill(0.001);
	const speech = new Float32Array(128);
	const output = new Float32Array(128);
	const render = (seconds: number): number => {
		for (let i = 0; i < seconds * 48000; i += 128) node.process([[input], [speech]], [[output]]);
		return output[127] / input[127];
	};
	expect(render(1)).toBeCloseTo(1);
	speech.fill(1);
	const afterOneSecond = render(1);
	expect(afterOneSecond).toBeGreaterThan(1.9);
	expect(afterOneSecond).toBeLessThan(2.01);
	speech.fill(0);
	expect(render(1)).toBeCloseTo(afterOneSecond);
	speech.fill(1);
	expect(render(5)).toBeCloseTo(10 ** (20 / 20), 3);
	input.fill(0.1);
	expect(render(5) * 0.1).toBeCloseTo(10 ** (-26 / 20), 4);
});

it('follows a live gain ceiling and target from a config message', () => {
	let Processor: new (
		options: object,
	) => {
		process(inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean;
		port: {onmessage: (event: {data: object}) => void};
	};
	runInNewContext(readFileSync(new URL('./voiceSoftGain.worklet.js', import.meta.url), 'utf8'), {
		sampleRate: 48000,
		AudioWorkletProcessor: class {
			port = {onmessage: null};
		},
		registerProcessor: (_name: string, value: typeof Processor) => {
			Processor = value;
		},
	});
	const node = new Processor!({processorOptions: {tuning: VOICE_PIPELINE_TUNING}});
	const input = new Float32Array(128).fill(0.001);
	const speech = new Float32Array(128).fill(1);
	const output = new Float32Array(128);
	const render = (seconds: number): number => {
		for (let i = 0; i < seconds * 48000; i += 128) node.process([[input], [speech]], [[output]]);
		return output[127] / input[127];
	};
	expect(render(2)).toBeGreaterThan(3.9);
	node.port.onmessage({data: {type: 'config', tuning: {...VOICE_PIPELINE_TUNING, gainMaxDb: 6, gainTargetDbfs: -20}}});
	expect(render(2)).toBeCloseTo(10 ** (6 / 20), 3);
	input.fill(0.1);
	expect(render(5) * 0.1).toBeCloseTo(10 ** (-20 / 20), 4);
});
