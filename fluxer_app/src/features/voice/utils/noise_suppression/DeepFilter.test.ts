// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: {}}));
vi.mock('@app/features/voice/engine/VoiceInputAudioContext', () => ({
	isVoiceInputSourceLive: () => false,
	acquireIdleVoiceInputContext: () => null,
}));
vi.mock('@app/features/voice/utils/VoiceProcessingProfile', () => ({getActiveVoiceProcessingMode: () => 'custom'}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', () => ({
	readRequestedNoiseSuppressionBackend: () => 'deep_filter',
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionWorkletAssets', () => ({
	DEEP_FILTER_WORKLET_URL: 'test-worklet.js',
}));

import {acquireDeepFilterNode, hasIdleDeepFilterNode} from '@app/features/voice/utils/noise_suppression/DeepFilter';

afterEach(() => vi.unstubAllGlobals());

describe('DeepFilter node attenuation', () => {
	it('uses 30 by default and does not reuse that node for an admin override', async () => {
		const limits: Array<number> = [];
		vi.stubGlobal(
			'fetch',
			async (url: string) =>
				new Response(url.endsWith('.wasm') ? new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) : new Uint8Array([31, 139])),
		);
		vi.stubGlobal(
			'AudioWorkletNode',
			class {
				port = {onmessage: null as ((event: {data: object}) => void) | null, postMessage: vi.fn(), close: vi.fn()};
				disconnect = vi.fn();
				constructor(_context: unknown, _name: string, options: {processorOptions: {attenLimDb: number}}) {
					limits.push(options.processorOptions.attenLimDb);
					queueMicrotask(() => this.port.onmessage?.({data: {type: 'ready', frameLength: 480}}));
				}
			},
		);
		const events = new EventTarget();
		const context = Object.assign(events, {
			state: 'running',
			sampleRate: 48000,
			currentTime: 0,
			audioWorklet: {addModule: async () => {}},
		});
		const signal = new AbortController().signal;
		try {
			const defaultLease = await acquireDeepFilterNode(context as unknown as AudioContext, signal, vi.fn());
			defaultLease.release();
			expect(hasIdleDeepFilterNode(context as unknown as AudioContext, 30)).toBe(true);
			expect(hasIdleDeepFilterNode(context as unknown as AudioContext, 73)).toBe(false);
			const overrideLease = await acquireDeepFilterNode(context as unknown as AudioContext, signal, vi.fn(), 73);
			overrideLease.release();
			const reused = await acquireDeepFilterNode(context as unknown as AudioContext, signal, vi.fn(), 73);
			expect(reused.node).toBe(overrideLease.node);
			reused.release();
			expect(limits).toEqual([30, 73]);
		} finally {
			context.state = 'closed';
			events.dispatchEvent(new Event('statechange'));
		}
	});
	it.each([false, true])('routes v2 health to a shared graph callback when provided (%s)', async (sharedGraph) => {
		const {default: availability} = await import('./NoiseSuppressionAvailability');
		availability.failures.clear();
		vi.stubGlobal(
			'fetch',
			async (url: string) =>
				new Response(url.endsWith('.wasm') ? new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) : new Uint8Array([31, 139])),
		);
		vi.stubGlobal(
			'AudioWorkletNode',
			class {
				port = {onmessage: null as ((event: {data: object}) => void) | null, postMessage: vi.fn(), close: vi.fn()};
				disconnect = vi.fn();
				constructor() {
					queueMicrotask(() => this.port.onmessage?.({data: {type: 'ready', frameLength: 480}}));
				}
			},
		);
		const context = Object.assign(new EventTarget(), {
			state: 'running',
			sampleRate: 48000,
			currentTime: 0,
			audioWorklet: {addModule: async () => {}},
		});
		const fault = vi.fn();
		const onHealth = vi.fn();
		let enabled = true;
		const lease = await acquireDeepFilterNode(
			context as unknown as AudioContext,
			new AbortController().signal,
			fault,
			80,
			() => enabled,
			sharedGraph ? onHealth : undefined,
		);
		try {
			expect(lease.node.port.postMessage).toHaveBeenCalledWith({type: 'pipeline', enabled: true});
			for (let i = 1; i <= 3; i++)
				lease.node.port.onmessage!({
					data: {
						type: 'health',
						inputRms: 0.1,
						outputRms: 0.1,
						nonFinite: false,
						contextTime: i / 2,
						frame: i * 50,
						processingMs: i * 450,
						audioMs: i * 500,
					},
				} as MessageEvent);
			expect(availability.getFallback('deep_filter')).toBe(sharedGraph ? null : 'cpu_budget');
			if (sharedGraph) expect(onHealth).toHaveBeenLastCalledWith(1350, 1500, 1.5);
			expect(fault).not.toHaveBeenCalled();
			enabled = false;
			lease.node.port.onmessage!({
				data: {
					type: 'health',
					inputRms: 0.1,
					outputRms: 0.1,
					nonFinite: false,
					contextTime: 2,
					frame: 200,
					processingMs: 1800,
					audioMs: 2000,
				},
			} as MessageEvent);
			expect(lease.node.port.postMessage).toHaveBeenLastCalledWith({type: 'pipeline', enabled: false});
		} finally {
			lease.release();
			context.state = 'closed';
			context.dispatchEvent(new Event('statechange'));
		}
	});
});

describe('DeepFilter asset progress watchdog', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'performance']});
		vi.spyOn(WebAssembly, 'compileStreaming').mockImplementation(async (source) => {
			await (await source).arrayBuffer();
			return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	async function startDownload() {
		let model!: ReadableStreamDefaultController<Uint8Array>;
		let downloadSignal!: AbortSignal;
		vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
			if (url.endsWith('.wasm')) return new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
			downloadSignal = options.signal!;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						model = controller;
						controller.enqueue(new Uint8Array([31, 139]));
						downloadSignal.addEventListener('abort', () => controller.error(downloadSignal.reason), {once: true});
					},
				}),
			);
		});
		const {loadDeepFilterAssets} = await import('@app/features/voice/utils/noise_suppression/DeepFilter');
		const outcome = loadDeepFilterAssets().then(
			() => null,
			(error: Error) => error,
		);
		await vi.advanceTimersByTimeAsync(0);
		return {model, outcome, downloadSignal};
	}

	it('does not cancel and allocate a timer for every response chunk; flush clears all watchdogs', async () => {
		const timers = vi.spyOn(globalThis, 'setTimeout');
		const {model, outcome} = await startDownload();
		for (let chunk = 0; chunk < 64; chunk++) model.enqueue(new Uint8Array([chunk]));
		model.close();
		expect(await outcome).toBeNull();
		expect(timers).toHaveBeenCalledTimes(3); // total deadline + one watchdog per asset
		expect(vi.getTimerCount()).toBe(0);
	});

	it('yields a long response burst to the browser without adding per-chunk timers', async () => {
		const yieldTask = vi.fn(async () => {});
		vi.stubGlobal('scheduler', {yield: yieldTask});
		const timers = vi.spyOn(globalThis, 'setTimeout');
		const {model, outcome} = await startDownload();
		await vi.advanceTimersByTimeAsync(9);
		model.enqueue(new Uint8Array([1]));
		await vi.advanceTimersByTimeAsync(0);
		model.close();
		expect(await outcome).toBeNull();
		expect(yieldTask).toHaveBeenCalledTimes(1);
		expect(timers).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('uses a task timer when scheduler.yield is unavailable', async () => {
		vi.stubGlobal('scheduler', undefined);
		const timers = vi.spyOn(globalThis, 'setTimeout');
		const {model, outcome} = await startDownload();
		await vi.advanceTimersByTimeAsync(9);
		model.enqueue(new Uint8Array([1]));
		model.close();
		await vi.advanceTimersByTimeAsync(1);
		expect(await outcome).toBeNull();
		expect(timers).toHaveBeenCalledTimes(4);
		expect(timers).toHaveBeenLastCalledWith(expect.any(Function), 0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps the idle deadline active while waiting for a browser task', async () => {
		let resume!: () => void;
		vi.stubGlobal('scheduler', {
			yield: () =>
				new Promise<void>((resolve) => {
					resume = resolve;
				}),
		});
		const {model, outcome, downloadSignal} = await startDownload();
		await vi.advanceTimersByTimeAsync(9);
		model.enqueue(new Uint8Array([1]));
		await vi.advanceTimersByTimeAsync(20_000);
		expect(downloadSignal.aborted).toBe(true);
		resume();
		expect(await outcome).toMatchObject({message: expect.stringContaining('No data from')});
		expect(vi.getTimerCount()).toBe(0);
	});

	it('allows continuous progress beyond the first deadline, then times out 20 seconds after the last chunk', async () => {
		const {model, outcome, downloadSignal} = await startDownload();
		await vi.advanceTimersByTimeAsync(19_000);
		model.enqueue(new Uint8Array([1]));
		await vi.advanceTimersByTimeAsync(19_000);
		expect(downloadSignal.aborted).toBe(false);
		model.enqueue(new Uint8Array([2]));
		await vi.advanceTimersByTimeAsync(19_999);
		expect(downloadSignal.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await outcome).toMatchObject({message: expect.stringContaining('No data from')});
		expect(downloadSignal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('clears pending watchdogs when a response body errors and aborts the shared download', async () => {
		const {model, outcome, downloadSignal} = await startDownload();
		model.error(new Error('connection lost'));
		expect(await outcome).toMatchObject({message: 'connection lost'});
		expect(downloadSignal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keeps the ten-minute total deadline even while chunks continue arriving', async () => {
		const {model, outcome, downloadSignal} = await startDownload();
		for (let chunk = 0; chunk < 59; chunk++) {
			await vi.advanceTimersByTimeAsync(10_000);
			model.enqueue(new Uint8Array([chunk]));
		}
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await outcome).toMatchObject({message: 'DeepFilterNet assets took too long to download'});
		expect(downloadSignal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
