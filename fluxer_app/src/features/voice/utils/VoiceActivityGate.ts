import {Logger} from '@app/features/platform/utils/AppLogger';
import {
	LOCAL_AUTO_MIN_RMS,
	LOCAL_MAX_RMS,
	SPEAKING_LOCAL_RELEASE_MS,
} from '@app/features/voice/engine/VoiceSpeakingThreshold';
import {VOICE_PIPELINE_TUNING, type VoicePipelineTuning} from '@app/features/voice/utils/VoicePipelineTuning';

const GATE_STARTUP_TIMEOUT_MS = 8000;
const modules = new WeakMap<AudioContext, Promise<void>>();
const vadModules = new WeakMap<AudioContext, Promise<void>>();
const gainModules = new WeakMap<AudioContext, Promise<void>>();
const logger = new Logger('VoiceActivityGate');

export interface VoiceActivityGateConfig {
	apply: boolean;
	auto: boolean;
	manualThresholdRms: number;
	pipelineV2Enabled?: boolean;
	tuning?: VoicePipelineTuning;
}

export interface VoiceInputLevel {
	rms: number;
	floorRms: number;
	thresholdRms: number;
	nonFinite: boolean;
	frame: number;
	contextTime: number;
	processingMs?: number;
	audioMs?: number;
}

function loadWorklet(
	context: AudioContext,
	signal: AbortSignal,
	cache: WeakMap<AudioContext, Promise<void>>,
	asset: 'VOICE_GATE_WORKLET_URL' | 'VOICE_VAD_WORKLET_URL' | 'VOICE_SOFT_GAIN_WORKLET_URL',
): Promise<void> {
	signal.throwIfAborted();
	let pending = cache.get(context);
	if (!pending) {
		pending = import('@app/features/voice/utils/noise_suppression/NoiseSuppressionWorkletAssets').then((assets) =>
			context.audioWorklet.addModule(assets[asset]),
		);
		cache.set(context, pending);
		void pending.catch(() => {
			if (cache.get(context) === pending) cache.delete(context);
		});
	}
	const loading = pending;
	return new Promise((resolve, reject) => {
		const finish = (error?: unknown): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			if (error === undefined) resolve();
			else reject(error);
		};
		const onAbort = (): void => finish(signal.reason);
		const timer = setTimeout(
			() => finish(new Error('Voice activity gate did not load in time')),
			GATE_STARTUP_TIMEOUT_MS,
		);
		signal.addEventListener('abort', onAbort, {once: true});
		if (signal.aborted) onAbort();
		void loading.then(() => finish(), finish);
	});
}

export async function loadVoiceActivityGate(
	context: AudioContext,
	signal: AbortSignal,
	pipelineV2Enabled = false,
): Promise<void> {
	await loadWorklet(context, signal, modules, 'VOICE_GATE_WORKLET_URL');
	if (!pipelineV2Enabled || context.sampleRate !== 48000) return;
	try {
		await loadWorklet(context, signal, vadModules, 'VOICE_VAD_WORKLET_URL');
	} catch (error) {
		signal.throwIfAborted();
		logger.warn('Speech detector unavailable; retaining RMS gate', error);
	}
}

export function loadVoiceSoftGain(context: AudioContext, signal: AbortSignal): Promise<void> {
	return loadWorklet(context, signal, gainModules, 'VOICE_SOFT_GAIN_WORKLET_URL');
}

export function createVoiceSoftGain(
	context: AudioContext,
	onFailure: () => void,
	onHealth?: (processingMs: number, audioMs: number, contextTime: number) => void,
	tuning: VoicePipelineTuning = VOICE_PIPELINE_TUNING,
): AudioWorkletNode {
	const node = new AudioWorkletNode(context, 'fluxer-voice-soft-gain', {
		numberOfInputs: 2,
		numberOfOutputs: 1,
		outputChannelCount: [1],
		channelCount: 1,
		channelCountMode: 'explicit',
		processorOptions: {tuning},
	});
	node.port.onmessage = ({data}: MessageEvent) => {
		if (
			data?.type === 'health' &&
			Number.isFinite(data.processingMs) &&
			data.processingMs >= 0 &&
			Number.isFinite(data.audioMs) &&
			data.audioMs > 0 &&
			Number.isFinite(data.contextTime) &&
			data.contextTime >= 0
		) {
			onHealth?.(data.processingMs, data.audioMs, data.contextTime);
		}
	};
	node.onprocessorerror = onFailure;
	return node;
}

export function createVoiceActivityGate(
	context: AudioContext,
	channelCount: 1 | 2,
	config: VoiceActivityGateConfig,
	onLevel: (level: VoiceInputLevel) => void,
	onFailure: () => void,
): AudioWorkletNode {
	const node = new AudioWorkletNode(context, 'fluxer-voice-gate', {
		numberOfInputs: 1,
		numberOfOutputs: 2,
		outputChannelCount: [channelCount, 1],
		channelCount,
		channelCountMode: 'explicit',
		channelInterpretation: 'speakers',
		processorOptions: {
			...config,
			tuning: config.tuning ?? VOICE_PIPELINE_TUNING,
			channelCount,
			minRms: LOCAL_AUTO_MIN_RMS,
			maxRms: LOCAL_MAX_RMS,
			releaseMs: SPEAKING_LOCAL_RELEASE_MS,
		},
	});
	node.port.onmessage = ({data}: MessageEvent<VoiceInputLevel & {type: string}>) => {
		if (data.type === 'level') onLevel(data);
		if (data.type === 'vad-failure') logger.warn('Speech detector failed; retaining RMS gate');
	};
	node.onprocessorerror = onFailure;
	return node;
}
