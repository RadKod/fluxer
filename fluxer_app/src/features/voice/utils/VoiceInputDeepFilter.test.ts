// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({
	idleContext: vi.fn(),
	onLevel: null as ((level: object) => void) | null,
}));
vi.mock('@app/features/input/state/InputKeybind', () => ({default: {transmitMode: 'voice_activity'}}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: {}}));
vi.mock('@app/features/voice/engine/VoiceInputAudioContext', () => ({
	isVoiceInputSourceLive: () => false,
	acquireIdleVoiceInputContext: state.idleContext,
}));
vi.mock('@app/features/voice/engine/VoiceSharedAudioContext', () => ({createVoiceSoftClipNode: () => null}));
vi.mock('@app/features/voice/utils/VoiceProcessingProfile', () => ({
	getActiveVoiceProcessingMode: () => 'custom',
	getActiveInputDeviceLabel: () => '',
	resolveVoiceProcessingFromStateForDeviceLabel: () => ({}),
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', () => ({
	readRequestedNoiseSuppressionBackend: () => 'deep_filter',
	readCaptureNoiseSuppressionBackend: () => 'standard',
	readVoicePipelineV2Enabled: () => true,
	resolveRuntimeVoiceProcessing: () => ({deepFilterNoiseReductionLevel: 80, pipelineV2Enabled: true}),
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionWorkletAssets', () => ({
	DEEP_FILTER_WORKLET_URL: 'test-worklet.js',
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionChain', () => ({}));
vi.mock('@app/features/voice/utils/VoiceActivityGate', () => ({
	loadVoiceActivityGate: async () => {},
	createVoiceActivityGate: (
		context: AudioContext,
		_channels: number,
		_config: unknown,
		onLevel: typeof state.onLevel,
	) => {
		state.onLevel = onLevel;
		return Object.assign(context.createGain(), {port: {postMessage: vi.fn(), close: vi.fn()}});
	},
}));

class FakeNode {
	gain = {
		value: 1,
		setTargetAtTime: vi.fn(),
		cancelScheduledValues: vi.fn(),
		setValueAtTime: vi.fn(),
		linearRampToValueAtTime: vi.fn(),
	};
	connect = vi.fn();
	disconnect = vi.fn();
}

class FakeContext extends EventTarget {
	state = 'running';
	sampleRate = 48000;
	currentTime = 0;
	audioWorklet = {addModule: vi.fn(async () => {})};
	createGain = () => new FakeNode();
}

const context = new FakeContext();
const audioContext = context as unknown as AudioContext;
const nodes: Array<{node: FakeNode; strength: number}> = [];

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']});
	context.state = 'running';
	nodes.length = 0;
	state.idleContext.mockReturnValue({context: audioContext, release: vi.fn()});
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async (url: string) =>
				new Response(url.endsWith('.wasm') ? new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) : new Uint8Array([31, 139])),
		),
	);
	vi.stubGlobal(
		'AudioWorkletNode',
		class extends FakeNode {
			port = {
				onmessage: null as ((event: {data: object}) => void) | null,
				postMessage: (message: {type: string}) => {
					if (message.type === 'flush') queueMicrotask(() => this.port.onmessage?.({data: {type: 'primed'}}));
				},
				close: vi.fn(),
			};
			constructor(_context: unknown, _name: string, options: {processorOptions: {attenLimDb: number}}) {
				super();
				nodes.push({node: this, strength: options.processorOptions.attenLimDb});
				queueMicrotask(() => this.port.onmessage?.({data: {type: 'ready', frameLength: 480}}));
			}
		},
	);
});

afterEach(() => {
	context.state = 'closed';
	context.dispatchEvent(new Event('statechange'));
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('DeepFilter voice join', () => {
	it('warms with the resolved custom strength and reuses that same node at 80', async () => {
		const {beginMicrophoneSession, awaitMicrophoneSessionWarmup, acquireDeepFilterNode} = await import(
			'./noise_suppression/DeepFilter'
		);
		beginMicrophoneSession();
		await awaitMicrophoneSessionWarmup();
		expect(nodes.map(({strength}) => strength)).toEqual([80]);
		const warmed = nodes[0].node;
		const lease = await acquireDeepFilterNode(audioContext, new AbortController().signal, vi.fn(), 80);
		expect(lease.node).toBe(warmed);
		expect(nodes).toHaveLength(1);
		lease.release();
	});

	it('requests the model and wasm when joining voice with DeepFilter selected', async () => {
		const {beginMicrophoneSession, awaitMicrophoneSessionWarmup} = await import('./noise_suppression/DeepFilter');
		expect(fetch).not.toHaveBeenCalled();
		beginMicrophoneSession();
		await awaitMicrophoneSessionWarmup();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/df_bg.wasm'), expect.any(Object));
		expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/DeepFilterNet3_onnx.tar.gz'), expect.any(Object));
	});

	it.each([30, 80])('only skips the speech pause for a matching idle node (idle strength %i)', async (idleStrength) => {
		const {acquireDeepFilterNode} = await import('./noise_suppression/DeepFilter');
		const idle = await acquireDeepFilterNode(audioContext, new AbortController().signal, vi.fn(), idleStrength);
		idle.release();
		const {VoiceInputGraph} = await import('./VoiceInputProcessor');
		const graph = new VoiceInputGraph(audioContext, 1, () => ({
			processingMode: 'custom',
			backend: 'deep_filter',
			suppressionStrength: 80,
			inputVolumePercent: 100,
			gateEnabled: true,
			gateAuto: true,
			gateThresholdRms: 0.01,
		}));
		graph.setSourceNode(
			{readyState: 'live'} as MediaStreamTrack,
			new FakeNode() as unknown as MediaStreamAudioSourceNode,
		);
		await graph.loadGate();
		state.onLevel!({rms: 0.1, thresholdRms: 0.01, contextTime: 0});
		let complete = false;
		const configured = graph.configure().then(() => {
			complete = true;
		});
		try {
			await vi.advanceTimersByTimeAsync(200);
			expect(complete).toBe(idleStrength === 80);
			expect(nodes.map(({strength}) => strength)).toEqual([idleStrength]);
			state.onLevel!({rms: 0, thresholdRms: 0.01, contextTime: 0});
			await vi.advanceTimersByTimeAsync(200);
			await configured;
			expect(nodes.map(({strength}) => strength)).toEqual(idleStrength === 80 ? [80] : [30, 80]);
		} finally {
			graph.dispose();
		}
	});
});
