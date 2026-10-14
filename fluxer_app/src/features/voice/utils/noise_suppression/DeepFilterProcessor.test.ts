// SPDX-License-Identifier: AGPL-3.0-or-later

import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {describe, expect, it, vi} from 'vitest';

describe('DeepFilter worklet CPU accounting', () => {
	it('passes microphone samples through when the model cannot start', () => {
		let processor!: {
			prototype: {process(inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean};
		};
		runInNewContext(readFileSync(new URL('./deepFilterProcessor.worklet.js', import.meta.url), 'utf8'), {
			AudioWorkletProcessor: class {},
			sampleRate: 48000,
			currentTime: 1,
			registerProcessor: (_name: string, value: typeof processor) => {
				processor = value;
			},
		});
		const input = Float32Array.from([0.1, -0.2, 0.3]);
		const output = new Float32Array(3);
		const instance = Object.assign(Object.create(processor.prototype), {disposed: false, running: false});
		expect(instance.process([[input]], [[output]])).toBe(true);
		expect(output).toEqual(input);
	});
	it.each([true, false])('accounts for CPU only when v2 is %s', (enabled) => {
		let processor!: {prototype: {processFrames(): void; reportHealth(): void}};
		let now = 100;
		runInNewContext(readFileSync(new URL('./deepFilterProcessor.worklet.js', import.meta.url), 'utf8'), {
			AudioWorkletProcessor: class {},
			sampleRate: 48000,
			currentTime: 1,
			Date: {now: () => (now += 3)},
			registerProcessor: (_name: string, value: typeof processor) => {
				processor = value;
			},
		});
		const port = {postMessage: vi.fn()};
		const frame = new Float32Array(480);
		const instance = Object.assign(Object.create(processor.prototype), {
			frameLength: 480,
			frame,
			inputRing: frame,
			inputWrite: 480,
			inputRead: 0,
			outputRing: new Float32Array(1920),
			outputWrite: 0,
			ringSize: 1920,
			bindings: {processFrame: () => frame},
			handle: 1,
			outputGain: 1,
			healthInputEnergy: 0,
			healthOutputEnergy: 0,
			healthSamples: 480,
			healthNonFinite: false,
			healthFrames: 49,
			processedFrames: 0,
			processingMs: 0,
			audioMs: 0,
			pipelineV2Enabled: enabled,
			port,
		});
		instance.processFrames();
		expect(port.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({type: 'health', processingMs: enabled ? 3 : 0, audioMs: enabled ? 10 : 0}),
		);
		instance.inputWrite = 960;
		instance.healthFrames = 49;
		instance.processFrames();
		expect(port.postMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({type: 'health', processingMs: enabled ? 6 : 0, audioMs: enabled ? 20 : 0}),
		);
	});
});
