// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {expect, it, vi} from 'vitest';

it('measures the real RNNoise worklet only while enabled and reports its cumulative CPU budget', async () => {
	const require = createRequire(import.meta.url);
	const loader = require('../../../../../scripts/build/rspack/noise-suppressor-worklet-loader.cjs');
	const resourcePath = require.resolve('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js');
	const transformed = loader.call({resourcePath}, readFileSync(resourcePath, 'utf8'));
	const messages: Array<{type: string; processingMs: number; audioMs: number}> = [];
	let listener: (event: {data: unknown}) => void;
	let Processor: new (
		options: object,
	) => {process(inputs: Array<Array<Float32Array>>, outputs: Array<Array<Float32Array>>): boolean};
	let ready!: () => void;
	let fail!: (error: Error) => void;
	const readyPromise = new Promise<void>((resolve, reject) => {
		ready = resolve;
		fail = reject;
	});
	let clock = 0;
	const now = vi.fn(() => {
		clock += 3;
		return clock;
	});
	runInNewContext(transformed.replaceAll('import.meta.url', "'file:///rnnoise.js'"), {
		WebAssembly,
		TextEncoder,
		TextDecoder,
		console,
		sampleRate: 48000,
		currentTime: 0,
		Date: {now},
		AudioWorkletProcessor: class {
			port = {
				addEventListener: (_name: string, callback: typeof listener) => {
					listener = callback;
				},
				start: vi.fn(),
				postMessage: (message: {type: string; message: string; processingMs: number; audioMs: number}) => {
					if (message.type === 'ready') ready();
					else if (message.type === 'error') fail(new Error(message.message));
					else messages.push(message);
				},
			};
		},
		registerProcessor: (_name: string, value: typeof Processor) => {
			Processor = value;
		},
	});
	const node = new Processor!({
		processorOptions: {
			maxChannels: 1,
			wasmBinary: readFileSync(require.resolve('@sapphi-red/web-noise-suppressor/rnnoise.wasm')),
			pipelineV2Enabled: false,
		},
	});
	await readyPromise;
	const input = new Float32Array(128);
	const output = new Float32Array(128);
	const render = () => {
		for (let i = 0; i < 570; i++) node.process([[input]], [[output]]);
	};
	now.mockClear();
	render();
	expect(now).not.toHaveBeenCalled();
	expect(messages).toHaveLength(0);
	listener!({data: {type: 'configure-health', enabled: true}});
	render();
	expect(messages.length).toBeGreaterThanOrEqual(3);
	expect(messages.at(-1)?.processingMs).toBeGreaterThan(messages.at(-1)!.audioMs);
	listener!({data: {type: 'configure-health', enabled: false}});
	now.mockClear();
	const reports = messages.length;
	render();
	expect(now).not.toHaveBeenCalled();
	expect(messages).toHaveLength(reports);
	listener!({data: 'destroy'});
});
