// SPDX-License-Identifier: AGPL-3.0-or-later

import {createMicTestAudioGraph} from '@app/features/user/components/modals/tabs/hooks/MicTestAudioGraph';
import {acquireDeepFilterNode, hasIdleDeepFilterNode} from '@app/features/voice/utils/noise_suppression/DeepFilter';
import NoiseSuppressionAvailability from '@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability';
import {createNoiseSuppressionWorkletNode} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionChain';
import type {VoiceInputLevel} from '@app/features/voice/utils/VoiceActivityGate';
import {type VoiceInputConfig, VoiceInputGraph} from '@app/features/voice/utils/VoiceInputProcessor';
import {VOICE_PIPELINE_TUNING} from '@app/features/voice/utils/VoicePipelineTuning';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/platform/utils/AppLogger', () => ({
	Logger: class {
		debug() {}
		warn() {}
	},
}));
vi.mock('@app/features/input/state/InputKeybind', () => ({default: {}}));
vi.mock('@app/features/voice/state/VoiceSettings', () => ({default: {}}));
vi.mock('@app/features/voice/engine/VoiceInputAudioContext', () => ({
	acquireVoiceInputSource: vi.fn(),
	discardVoiceInputContext: vi.fn(),
}));
vi.mock('@app/features/voice/utils/VoiceProcessingProfile', () => ({
	getActiveInputDeviceLabel: vi.fn(),
	resolveVoiceProcessingFromStateForDeviceLabel: vi.fn(),
}));
vi.mock('@app/features/voice/utils/noise_suppression/DeepFilter', () => ({
	acquireDeepFilterNode: vi.fn(),
	hasIdleDeepFilterNode: vi.fn(),
	reportVoiceInputLevel: vi.fn(),
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionChain', () => ({
	createNoiseSuppressionWorkletNode: vi.fn(),
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime', () => ({
	resolveRuntimeVoiceProcessing: vi.fn(),
	readEffectiveNoiseSuppression: vi.fn(),
	readCaptureNoiseSuppressionBackend: vi.fn(() => 'standard'),
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability', () => ({
	default: {
		setVoiceInputRuntime: vi.fn(),
		reportProcessingHealth: vi.fn(),
		markPipelineV2Failed: vi.fn(),
		configureProcessingHealth: vi.fn(),
	},
}));
vi.mock('@app/features/voice/utils/noise_suppression/NoiseSuppressionWorkletAssets', () => ({
	VOICE_GATE_WORKLET_URL: '/gate.js',
	VOICE_SOFT_GAIN_WORKLET_URL: '/gain.js',
	VOICE_VAD_WORKLET_URL: '/vad.js',
}));

class FakeAudioParam {
	value = 1;
	setTargetAtTime(value: number): void {
		this.value = value;
	}
	cancelScheduledValues(): void {}
	setValueAtTime(value: number): void {
		this.value = value;
	}
	linearRampToValueAtTime(value: number): void {
		this.value = value;
	}
}

class FakeAudioNode {
	readonly connections = new Set<FakeAudioNode>();
	readonly controlConnections = new Set<FakeAudioNode>();
	readonly gain = new FakeAudioParam();
	readonly frequency = new FakeAudioParam();
	readonly Q = new FakeAudioParam();
	readonly delayTime = new FakeAudioParam();
	type = '';
	constructor(readonly kind: 'source' | 'gain' | 'shaper' | 'gate' | 'highpass' | 'softgain') {}
	connect(target: FakeAudioNode, output = 0): FakeAudioNode {
		(output === 1 ? this.controlConnections : this.connections).add(target);
		return target;
	}
	disconnect(target?: FakeAudioNode): void {
		if (target) {
			this.connections.delete(target);
			this.controlConnections.delete(target);
		} else {
			this.connections.clear();
			this.controlConnections.clear();
		}
	}
}

class FakeAudioContext {
	currentTime = 0;
	sampleRate = 48000;
	readonly nodes: Array<FakeAudioNode> = [];
	readonly audioWorklet = {addModule: vi.fn(async () => {})};
	createGain(): FakeAudioNode {
		return this.add(new FakeAudioNode('gain'));
	}
	createWaveShaper(): FakeAudioNode {
		return this.add(new FakeAudioNode('shaper'));
	}
	createBiquadFilter(): FakeAudioNode {
		return this.add(new FakeAudioNode('highpass'));
	}
	createAnalyser(): FakeAudioNode {
		return this.add(new FakeAudioNode('gain'));
	}
	createDelay(): FakeAudioNode {
		return this.add(new FakeAudioNode('gain'));
	}
	add<T extends FakeAudioNode>(node: T): T {
		this.nodes.push(node);
		return node;
	}
}

class FakeAudioWorkletNode extends FakeAudioNode {
	readonly port = {
		onmessage: null as ((event: {data: VoiceInputLevel & {type: string}}) => void) | null,
		postMessage: vi.fn(),
		close: vi.fn(),
	};
	onprocessorerror: (() => void) | null = null;
	constructor(
		context: FakeAudioContext,
		name: string,
		readonly options: AudioWorkletNodeOptions = {},
	) {
		super(name === 'fluxer-voice-soft-gain' ? 'softgain' : 'gate');
		context.add(this);
	}
}

// Inspect actual production connections; no DSP or production routing is reimplemented.
function pathsTo(source: FakeAudioNode, output: FakeAudioNode): Array<Array<FakeAudioNode>> {
	if (source === output) return [[output]];
	return [...source.connections].flatMap((next) => pathsTo(next, output).map((path) => [source, ...path]));
}

const graphs: Array<VoiceInputGraph> = [];
function setup(inputVolumePercent = 100, channels: 1 | 2 = 1) {
	const context = new FakeAudioContext();
	const config: VoiceInputConfig = {
		processingMode: 'studio',
		backend: 'none',
		suppressionStrength: 30,
		inputVolumePercent,
		gateEnabled: false,
		gateAuto: true,
		gateThresholdRms: 0.008,
	};
	const onLevel = vi.fn();
	const graph = new VoiceInputGraph(context as unknown as AudioContext, channels, () => config, onLevel);
	graphs.push(graph);
	const source = context.add(new FakeAudioNode('source'));
	graph.setSourceNode({readyState: 'live'} as MediaStreamTrack, source as unknown as MediaStreamAudioSourceNode);
	const output = graph.output as unknown as FakeAudioNode;
	return {context, config, graph, source, output, onLevel};
}

beforeEach(() => {
	vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
	vi.mocked(NoiseSuppressionAvailability.reportProcessingHealth).mockReset();
	vi.mocked(NoiseSuppressionAvailability.markPipelineV2Failed).mockReset();
	vi.mocked(NoiseSuppressionAvailability.configureProcessingHealth).mockReset();
	vi.mocked(createNoiseSuppressionWorkletNode).mockReset();
	vi.mocked(acquireDeepFilterNode).mockReset();
	vi.mocked(hasIdleDeepFilterNode).mockReturnValue(true);
});
afterEach(() => {
	for (const graph of graphs.splice(0)) graph.dispose();
	vi.unstubAllGlobals();
});

describe('voice pipeline v2 graph', () => {
	it('falls from RNNoise to standard through real aggregate availability when filter cost dominates', async () => {
		const {default: availability} = await vi.importActual<
			typeof import('./noise_suppression/NoiseSuppressionAvailability')
		>('./noise_suppression/NoiseSuppressionAvailability');
		availability.failures.clear();
		vi.mocked(NoiseSuppressionAvailability.reportProcessingHealth).mockImplementation(
			availability.reportProcessingHealth,
		);
		vi.mocked(NoiseSuppressionAvailability.configureProcessingHealth).mockImplementation(
			availability.configureProcessingHealth,
		);
		const context = new FakeAudioContext();
		const filter = new FakeAudioWorkletNode(context, 'rnnoise');
		vi.mocked(createNoiseSuppressionWorkletNode).mockResolvedValue({
			node: filter as unknown as AudioWorkletNode,
			dispose: vi.fn(),
		});
		const graph = new VoiceInputGraph(context as unknown as AudioContext, 1, () => ({
			processingMode: 'custom',
			pipelineV2Enabled: true,
			backend: availability.resolveEffectiveBackend('rnnoise', true),
			suppressionStrength: 80,
			inputVolumePercent: 100,
			gateEnabled: true,
			gateAuto: true,
			gateThresholdRms: 0.008,
		}));
		graphs.push(graph);
		const dispose = availability.subscribe(() => void graph.configure());
		try {
			await graph.configure();
			const health = vi.mocked(createNoiseSuppressionWorkletNode).mock.calls[0][2]!.onHealth;
			expect(health).toBeTypeOf('function');
			const gate = context.nodes.find((node) => node.kind === 'gate' && node !== filter) as FakeAudioWorkletNode;
			const gain = context.nodes.find((node) => node.kind === 'softgain') as FakeAudioWorkletNode;
			for (let window = 1; window <= 4; window++) {
				health!(window * 425, window * 500, window / 2);
				gate.port.onmessage?.({
					data: {
						type: 'level',
						processingMs: window * 5,
						audioMs: window * 500,
						contextTime: window / 2,
					} as VoiceInputLevel & {type: string},
				});
				gain.port.onmessage?.({
					data: {
						type: 'health',
						processingMs: window * 5,
						audioMs: window * 500,
						contextTime: window / 2,
					} as VoiceInputLevel & {type: string},
				});
			}
			await graph.configure();
			expect(availability.resolveEffectiveBackend('rnnoise', true)).toBe('standard');
			expect(availability.failures.get('rnnoise')?.reason).toBe('cpu_budget');
			expect(filter.port.postMessage).toHaveBeenCalledWith({type: 'configure-health', enabled: false});
		} finally {
			dispose();
			availability.failures.clear();
		}
	});
	it('reports the active filter and gain into the same graph CPU budget as the gate', async () => {
		const {graph, config, context} = setup();
		const filter = new FakeAudioWorkletNode(context, 'rnnoise');
		vi.mocked(createNoiseSuppressionWorkletNode).mockResolvedValue({
			node: filter as unknown as AudioWorkletNode,
			dispose: vi.fn(),
		});
		config.processingMode = 'custom';
		config.pipelineV2Enabled = true;
		config.backend = 'rnnoise';
		await graph.configure();
		const options = vi.mocked(createNoiseSuppressionWorkletNode).mock.calls[0][2]!;
		expect(options.onHealth).toBeTypeOf('function');
		options.onHealth!(300, 500, 1);
		const gain = context.nodes.find((node) => node.kind === 'softgain') as FakeAudioWorkletNode;
		gain.port.onmessage?.({
			data: {type: 'health', processingMs: 20, audioMs: 500, contextTime: 1} as VoiceInputLevel & {type: string},
		});
		expect(NoiseSuppressionAvailability.configureProcessingHealth).toHaveBeenLastCalledWith(
			graph,
			'rnnoise',
			['filter', 'gate', 'gain'],
			false,
		);
		expect(NoiseSuppressionAvailability.reportProcessingHealth).toHaveBeenCalledWith(
			'rnnoise',
			300,
			500,
			true,
			'filter',
			graph,
		);
		expect(NoiseSuppressionAvailability.reportProcessingHealth).toHaveBeenCalledWith(
			'rnnoise',
			20,
			500,
			true,
			'gain',
			graph,
		);
		config.backend = 'none';
		await graph.configure();
		vi.mocked(NoiseSuppressionAvailability.reportProcessingHealth).mockClear();
		options.onHealth!(900, 1000, 2);
		expect(NoiseSuppressionAvailability.reportProcessingHealth).not.toHaveBeenCalled();
	});
	it('keeps the previous audible path when a DeepFilter slot cannot load', async () => {
		const {graph, config, source, output} = setup();
		config.processingMode = 'custom';
		config.pipelineV2Enabled = true;
		await graph.configure();
		const before = pathsTo(source, output);
		expect(before).toHaveLength(1);
		config.backend = 'deep_filter';
		vi.mocked(acquireDeepFilterNode).mockRejectedValue(new Error('model unavailable'));
		await graph.configure();
		expect(acquireDeepFilterNode).toHaveBeenCalledOnce();
		expect(pathsTo(source, output)).toEqual(before);
		expect(before[0].every((node) => node.gain.value !== 0)).toBe(true);
	});
	it('disables only VAD if the standard backend still exceeds the gate CPU budget', async () => {
		const {graph, config, context, source, output} = setup();
		config.processingMode = 'custom';
		config.pipelineV2Enabled = true;
		await graph.configure();
		vi.mocked(NoiseSuppressionAvailability.reportProcessingHealth).mockReturnValue(true);
		const gate = context.nodes.find((node) => node.kind === 'gate') as FakeAudioWorkletNode;
		gate.port.onmessage?.({
			data: {
				type: 'level',
				rms: 0.1,
				thresholdRms: 0.01,
				floorRms: 0.001,
				nonFinite: false,
				frame: 4800,
				contextTime: 1,
				processingMs: 900,
				audioMs: 1000,
			},
		});
		expect(NoiseSuppressionAvailability.reportProcessingHealth).toHaveBeenCalledWith(
			'standard',
			900,
			1000,
			true,
			'gate',
			graph,
		);
		expect(gate.port.postMessage).toHaveBeenCalledWith({type: 'disable-vad'});
		expect(
			pathsTo(source, output)
				.flat()
				.some((node) => node.kind === 'highpass'),
		).toBe(true);
	});
	it('uses the same v2 chain in microphone preview without enabling the gate', async () => {
		const context = new FakeAudioContext();
		const source = Object.assign(context.add(new FakeAudioNode('source')), {context});
		const target = context.add(new FakeAudioNode('gain'));
		const config: VoiceInputConfig = {
			processingMode: 'custom',
			backend: 'none',
			suppressionStrength: 30,
			inputVolumePercent: 100,
			gateEnabled: false,
			gateAuto: true,
			gateThresholdRms: 0.008,
			pipelineV2Enabled: true,
		};
		const controller = new AbortController();
		const graph = createMicTestAudioGraph({
			signal: controller.signal,
			source: source as unknown as MediaStreamAudioSourceNode,
			sourceTrack: {readyState: 'live'} as MediaStreamTrack,
			channelCount: 1,
			resolveConfig: () => config,
			outputGain: 1,
			playbackTarget: target as unknown as AudioNode,
			playbackDelaySeconds: 0.1,
		});
		try {
			await graph.configure();
			const paths = pathsTo(source, target);
			expect(paths.flat().some((node) => node.kind === 'highpass')).toBe(true);
			const gate = context.nodes.find((node) => node.kind === 'gate') as FakeAudioWorkletNode;
			expect(gate.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'config', apply: false}));
			config.pipelineV2Enabled = false;
			await graph.configure();
			expect(
				pathsTo(source, target)
					.flat()
					.some((node) => node.kind === 'softgain'),
			).toBe(false);
		} finally {
			controller.abort();
		}
		expect(source.connections.size).toBe(0);
	});
	it('inserts HPF then soft gain before user gain and restores the legacy chain live', async () => {
		const {graph, config, context, source, output} = setup(150);
		config.processingMode = 'custom';
		config.pipelineV2Enabled = true;
		await graph.configure();
		await graph.loadGate();
		const filter = context.nodes.find((node) => node.kind === 'highpass')!;
		expect(filter).toBeDefined();
		expect(filter.type).toBe('highpass');
		expect(filter.frequency.value).toBe(100);
		expect(filter.Q.value).toBeCloseTo(-3.0102999566);
		const gate = context.nodes.find((node) => node.kind === 'gate')!;
		expect([...gate.controlConnections].map((node) => node.kind)).toEqual(['softgain']);
		const path = pathsTo(source, output).find((nodes) => nodes.includes(filter))!;
		expect(path.slice(path.indexOf(filter) - 1).map((node) => node.kind)).toEqual([
			'gate',
			'highpass',
			'softgain',
			'gain',
			'gain',
			'shaper',
			'gain',
		]);
		config.pipelineV2Enabled = false;
		await graph.configure();
		expect(
			pathsTo(source, output)
				.flat()
				.some((node) => node.kind === 'highpass' || node.kind === 'softgain'),
		).toBe(false);
		config.pipelineV2Enabled = true;
		await graph.configure();
		expect(pathsTo(source, output).some((nodes) => nodes.includes(filter))).toBe(true);
	});

	it('builds the gate and gain worklets with the assignment tuning', async () => {
		const tuning = {
			...VOICE_PIPELINE_TUNING,
			gateOpenProbability: 0.8,
			gateRefreshProbability: 0.5,
			gateHangoverMs: 900,
			gainTargetDbfs: -20,
			gainMaxDb: 10,
		};
		const {graph, config, context} = setup();
		config.processingMode = 'custom';
		config.pipelineV2Enabled = true;
		config.pipelineV2Tuning = tuning;
		await graph.configure();
		const gate = context.nodes.find((node) => node.kind === 'gate') as FakeAudioWorkletNode;
		const gain = context.nodes.find((node) => node.kind === 'softgain') as FakeAudioWorkletNode;
		expect(gate.options.processorOptions.tuning).toEqual(tuning);
		expect(gain.options.processorOptions.tuning).toEqual(tuning);
	});

	it('sends changed tuning to the running worklets without rebuilding the graph', async () => {
		const {graph, config, context, source, output} = setup();
		const filter = new FakeAudioWorkletNode(context, 'rnnoise');
		vi.mocked(createNoiseSuppressionWorkletNode).mockResolvedValue({
			node: filter as unknown as AudioWorkletNode,
			dispose: vi.fn(),
		});
		config.processingMode = 'custom';
		config.pipelineV2Enabled = true;
		config.backend = 'rnnoise';
		await graph.configure();
		const paths = pathsTo(source, output);
		expect(paths.flat().some((node) => node.kind === 'softgain')).toBe(true);
		const nodeCount = context.nodes.length;
		const gate = context.nodes.find((node) => node.kind === 'gate' && node !== filter) as FakeAudioWorkletNode;
		const gain = context.nodes.find((node) => node.kind === 'softgain') as FakeAudioWorkletNode;
		gate.port.postMessage.mockClear();
		gain.port.postMessage.mockClear();
		const tuning = {...VOICE_PIPELINE_TUNING, gateHangoverMs: 800, gainMaxDb: 8};
		config.pipelineV2Tuning = tuning;
		await graph.configure();
		expect(gate.port.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({type: 'config', pipelineV2Enabled: true, tuning}),
		);
		expect(gain.port.postMessage).toHaveBeenCalledWith({type: 'config', tuning});
		expect(gate.port.postMessage).not.toHaveBeenCalledWith({type: 'reset'});
		expect(gain.port.postMessage).not.toHaveBeenCalledWith({type: 'reset'});
		expect(context.nodes).toHaveLength(nodeCount);
		expect(pathsTo(source, output)).toEqual(paths);
		expect(createNoiseSuppressionWorkletNode).toHaveBeenCalledOnce();
	});

	it('keeps the legacy gate options and messages while v2 is off', async () => {
		const {graph, config, context} = setup();
		config.processingMode = 'custom';
		config.gateEnabled = true;
		config.pipelineV2Tuning = {...VOICE_PIPELINE_TUNING, gateOpenProbability: 0.9, gainMaxDb: 5};
		await graph.configure();
		await graph.loadGate();
		await graph.configure();
		const gate = context.nodes.find((node) => node.kind === 'gate') as FakeAudioWorkletNode;
		expect(gate.options.processorOptions.tuning).toBe(VOICE_PIPELINE_TUNING);
		expect(Object.keys(gate.options.processorOptions).sort()).toEqual([
			'apply',
			'auto',
			'channelCount',
			'manualThresholdRms',
			'maxRms',
			'minRms',
			'pipelineV2Enabled',
			'releaseMs',
			'tuning',
		]);
		expect(gate.port.postMessage.mock.calls).toStrictEqual([
			[{type: 'config', pipelineV2Enabled: false, apply: true, auto: true, manualThresholdRms: 0.008}],
		]);
		expect(context.nodes.some((node) => node.kind === 'highpass' || node.kind === 'softgain')).toBe(false);
	});

	it.each([1, 2] as const)('keeps studio and stereo outside v2 processing (%s channels)', async (channels) => {
		const {graph, config, source, output} = setup(100, channels);
		config.pipelineV2Enabled = true;
		if (channels === 2) config.processingMode = 'custom';
		await graph.configure();
		await graph.loadGate();
		expect(
			pathsTo(source, output)
				.flat()
				.some((node) => node.kind === 'highpass' || node.kind === 'softgain'),
		).toBe(false);
	});

	it('returns to the audible legacy chain if the gain processor fails', async () => {
		const {graph, config, context, source, output} = setup();
		config.processingMode = 'custom';
		config.pipelineV2Enabled = true;
		await graph.configure();
		await graph.loadGate();
		const gain = context.nodes.find((node) => node.kind === 'softgain') as FakeAudioWorkletNode;
		expect(gain).toBeDefined();
		gain.onprocessorerror?.();
		expect(NoiseSuppressionAvailability.markPipelineV2Failed).toHaveBeenCalledOnce();
		const paths = pathsTo(source, output);
		expect(paths.length).toBeGreaterThan(0);
		expect(paths.flat().some((node) => node.kind === 'highpass' || node.kind === 'softgain')).toBe(false);
	});

	it('keeps the legacy output audible if the gain module fails to load', async () => {
		const {graph, config, context, source, output} = setup();
		config.processingMode = 'custom';
		config.pipelineV2Enabled = true;
		context.audioWorklet.addModule.mockImplementation(async (url?: string) => {
			if (url === '/gain.js') throw new Error('worklet unavailable');
		});
		await graph.configure();
		expect(context.audioWorklet.addModule).toHaveBeenCalledWith('/gain.js');
		expect(NoiseSuppressionAvailability.markPipelineV2Failed).toHaveBeenCalledOnce();
		const paths = pathsTo(source, output);
		expect(paths.length).toBeGreaterThan(0);
		expect(paths.flat().some((node) => node.kind === 'highpass' || node.kind === 'softgain')).toBe(false);
	});
});

describe('studio input graph', () => {
	it.each([100, 200])('routes %s percent gain linearly without the gate or soft clip', async (volume) => {
		const {graph, source, output, context} = setup(volume);
		await graph.configure();
		await graph.loadGate();
		const paths = pathsTo(source, output);
		const audible = paths.filter((path) => path.every((node) => node.gain.value !== 0));
		expect(audible).toHaveLength(1);
		expect(audible[0].map((node) => node.kind)).toEqual(['source', 'gain', 'gain', 'gain']);
		expect(audible[0].reduce((gain, node) => gain * node.gain.value, 1)).toBe(volume / 100);
		const observer = paths.filter((path) => path.some((node) => node.kind === 'gate'));
		expect(observer).toHaveLength(1);
		expect(observer[0].some((node) => node.gain.value === 0)).toBe(true);
		expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
	});

	it('keeps speaking observation active on the silent branch', async () => {
		const {graph, context, onLevel} = setup();
		await graph.loadGate();
		const gate = context.nodes.find((node) => node.kind === 'gate') as FakeAudioWorkletNode;
		const level = {
			type: 'level',
			rms: 0.1,
			floorRms: 0.001,
			thresholdRms: 0.008,
			nonFinite: false,
			frame: 128,
			contextTime: 1,
		};
		gate.port.onmessage?.({data: level});
		expect(onLevel).toHaveBeenCalledExactlyOnceWith(level);
	});

	it('reroutes custom and studio live while preserving the output and changing gain', async () => {
		const {graph, config, source, output} = setup();
		await graph.configure();
		await graph.loadGate();
		config.processingMode = 'custom';
		await graph.configure();
		const custom = pathsTo(source, output);
		expect(custom).toHaveLength(1);
		expect(custom[0].map((node) => node.kind)).toEqual([
			'source',
			'gain',
			'gain',
			'gain',
			'gate',
			'gain',
			'gain',
			'shaper',
			'gain',
		]);
		config.processingMode = 'studio';
		config.inputVolumePercent = 200;
		await graph.configure();
		const restored = pathsTo(source, output).filter((path) => path.every((node) => node.gain.value !== 0));
		expect(restored).toHaveLength(1);
		expect(restored[0].map((node) => node.kind)).toEqual(['source', 'gain', 'gain', 'gain']);
		expect(restored[0].reduce((gain, node) => gain * node.gain.value, 1)).toBe(2);
		expect(graph.output).toBe(output);
	});
});
