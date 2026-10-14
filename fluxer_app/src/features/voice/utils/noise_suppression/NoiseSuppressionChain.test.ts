// SPDX-License-Identifier: AGPL-3.0-or-later
import {afterEach, expect, it, vi} from 'vitest';
import {createNoiseSuppressionWorkletNode} from './NoiseSuppressionChain';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug = vi.fn();
	},
}));
vi.mock('./NoiseSuppressionBackends', () => ({detectWasmSimdSupport: () => false}));
vi.mock('./NoiseSuppressionWorkletAssets', () => ({
	NOISE_SUPPRESSION_WORKLET_MODULE_URLS: {rnnoise: 'rnnoise.js'},
	NOISE_SUPPRESSION_WASM_URLS: {rnnoise: 'rnnoise.wasm'},
}));
afterEach(() => vi.unstubAllGlobals());

it('forwards RNNoise health separately from failures and ignores malformed or retired reports', async () => {
	let processorOptions: Record<string, unknown> | undefined;
	vi.stubGlobal('window', {setTimeout, clearTimeout});
	vi.stubGlobal('fetch', async () => new Response(new Uint8Array([0])));
	vi.stubGlobal(
		'AudioWorkletNode',
		class {
			port = {
				onmessage: null as ((event: {data: unknown}) => void) | null,
				start: vi.fn(),
				close: vi.fn(),
				postMessage: vi.fn(),
			};
			disconnect = vi.fn();
			constructor(_context: unknown, _name: string, options: AudioWorkletNodeOptions) {
				processorOptions = options.processorOptions;
				queueMicrotask(() => this.port.onmessage?.({data: {type: 'ready'}}));
			}
		},
	);
	const onHealth = vi.fn();
	const onRuntimeFailure = vi.fn();
	const result = await createNoiseSuppressionWorkletNode(
		{audioWorklet: {addModule: vi.fn().mockResolvedValue(undefined)}} as unknown as AudioContext,
		'rnnoise',
		{
			signal: new AbortController().signal,
			suppressionStrength: 30,
			pipelineV2Enabled: true,
			onHealth,
			onRuntimeFailure,
		},
	);
	expect(processorOptions?.pipelineV2Enabled).toBe(true);
	const dispatch = (data: unknown) =>
		result.node.port.onmessage?.call(result.node.port, new MessageEvent('message', {data}));
	dispatch({type: 'health', processingMs: 450, audioMs: 500, contextTime: 1});
	expect(onHealth).toHaveBeenCalledWith(450, 500, 1);
	dispatch({type: 'health', processingMs: Number.NaN, audioMs: 500, contextTime: 1});
	dispatch({type: 'health', processingMs: 450, audioMs: -1, contextTime: 1});
	expect(onHealth).toHaveBeenCalledTimes(1);
	expect(onRuntimeFailure).not.toHaveBeenCalled();
	const retired = result.node.port.onmessage!;
	result.dispose();
	retired.call(
		result.node.port,
		new MessageEvent('message', {data: {type: 'health', processingMs: 900, audioMs: 1000, contextTime: 2}}),
	);
	expect(onHealth).toHaveBeenCalledTimes(1);
});
