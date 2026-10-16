// SPDX-License-Identifier: AGPL-3.0-or-later

import Keybind from '@app/features/input/state/InputKeybind';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {isAbortError} from '@app/features/platform/utils/PlatformHelpers';
import {
	acquireVoiceInputSource,
	discardVoiceInputContext,
	type VoiceInputContextLease,
} from '@app/features/voice/engine/VoiceInputAudioContext';
import {createVoiceSoftClipNode} from '@app/features/voice/engine/VoiceSharedAudioContext';
import {getLocalSpeakingThresholdRms} from '@app/features/voice/engine/VoiceSpeakingThreshold';
import VoiceSettings from '@app/features/voice/state/VoiceSettings';
import {
	acquireDeepFilterNode,
	hasIdleDeepFilterNode,
	reportVoiceInputLevel,
} from '@app/features/voice/utils/noise_suppression/DeepFilter';
import NoiseSuppressionAvailability from '@app/features/voice/utils/noise_suppression/NoiseSuppressionAvailability';
import {
	getNoiseSuppressionBackendDescriptor,
	type VoiceNoiseSuppressionBackend,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionBackends';
import {createNoiseSuppressionWorkletNode} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionChain';
import {
	readCaptureNoiseSuppressionBackend,
	readEffectiveNoiseSuppression,
	readNoiseSuppressionStrength,
	resolveRuntimeVoiceProcessing,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionRuntime';
import type {NoiseSuppressionWorkletBackend} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionWorkletTypes';
import {
	createVoiceActivityGate,
	createVoiceSoftGain,
	loadVoiceActivityGate,
	loadVoiceSoftGain,
	type VoiceActivityGateConfig,
	type VoiceInputLevel,
} from '@app/features/voice/utils/VoiceActivityGate';
import {VOICE_PIPELINE_TUNING, type VoicePipelineTuning} from '@app/features/voice/utils/VoicePipelineTuning';
import {
	getActiveInputDeviceLabel,
	resolveVoiceProcessingFromStateForDeviceLabel,
	type VoiceProcessingMode,
} from '@app/features/voice/utils/VoiceProcessingProfile';
import {inputVoiceVolumePercentToGain} from '@app/features/voice/utils/VoiceVolumeUtils';
import type {ProcessorOptions, Track, TrackProcessor} from 'livekit-client';

const logger = new Logger('VoiceInputProcessor');
const VOLUME_TIME_CONSTANT = 0.01;
const SLOT_CROSSFADE_SECONDS = 0.02;
const SLOT_RELEASE_DELAY_MS = 30;
const CONTEXT_STALL_TIMEOUT_MS = 3000;
const PAUSE_POLL_MS = 20;
const PAUSE_MIN_MS = 150;
const PAUSE_WAIT_MAX_MS = 3000;

export type VoiceInputChannelCount = 1 | 2;

export interface VoiceInputConfig {
	pipelineV2Enabled?: boolean;
	pipelineV2Tuning?: VoicePipelineTuning;
	processingMode: VoiceProcessingMode;
	backend: VoiceNoiseSuppressionBackend;
	suppressionStrength: number;
	inputVolumePercent: number;
	gateEnabled: boolean;
	gateAuto: boolean;
	gateThresholdRms: number;
}

export function isVoiceActivityGateEnabled(): boolean {
	const profile = resolveRuntimeVoiceProcessing(
		resolveVoiceProcessingFromStateForDeviceLabel(VoiceSettings, getActiveInputDeviceLabel(VoiceSettings)),
	);
	return Keybind.transmitMode === 'voice_activity' && profile.mode !== 'studio' && !profile.stereoCapture;
}

export function resolveVoiceInputConfig(): VoiceInputConfig {
	const profile = resolveRuntimeVoiceProcessing(
		resolveVoiceProcessingFromStateForDeviceLabel(VoiceSettings, getActiveInputDeviceLabel(VoiceSettings)),
	);
	return {
		pipelineV2Enabled: profile.pipelineV2Enabled,
		pipelineV2Tuning: readEffectiveNoiseSuppression(48000).pipelineV2Tuning,
		processingMode: profile.mode,
		backend: profile.noiseSuppressionBackend,
		suppressionStrength: readNoiseSuppressionStrength(profile),
		inputVolumePercent: VoiceSettings.getInputVolume(),
		gateEnabled: isVoiceActivityGateEnabled(),
		gateAuto: profile.mode !== 'custom' || VoiceSettings.getVadAutoSensitivity(),
		gateThresholdRms: getLocalSpeakingThresholdRms(VoiceSettings.getVadThreshold()),
	};
}

type SuppressionSlotKey = 'passthrough' | 'deep_filter' | NoiseSuppressionWorkletBackend;

interface SuppressionSlot {
	readonly key: SuppressionSlotKey;
	readonly output: GainNode;
	readonly suppressionStrength?: number;
	configureHealth?(enabled: boolean): void;
	dispose(): void;
}

function disconnectEdge(from: AudioNode, to: AudioNode): void {
	try {
		from.disconnect(to);
	} catch {}
}

function rampGain(param: AudioParam, target: number, context: BaseAudioContext): void {
	const t0 = context.currentTime;
	param.cancelScheduledValues(t0);
	param.setValueAtTime(param.value, t0);
	param.linearRampToValueAtTime(target, t0 + SLOT_CROSSFADE_SECONDS);
}

export class VoiceInputGraph {
	readonly output: AudioNode;
	private sourceTrack: MediaStreamTrack | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private readonly inputMix: GainNode;
	private slot: SuppressionSlot;
	private readonly retiringSlots = new Map<SuppressionSlot, ReturnType<typeof setTimeout>>();
	private readonly gate: GainNode;
	private readonly volume: GainNode;
	private readonly softClip: {input: GainNode; output: WaveShaperNode} | null;
	private readonly observerSink: GainNode;
	private directInput: boolean | null = null;
	private gateNode: AudioWorkletNode | null = null;
	private gateLoad: Promise<void> | null = null;
	private gateFailed = false;
	private pipelineV2Load: Promise<void> | null = null;
	private pipelineV2Failed = false;
	private pipelineV2Routed = false;
	private highpass: BiquadFilterNode | null = null;
	private softGain: AudioWorkletNode | null = null;
	private level: VoiceInputLevel | null = null;
	private configureRun: Promise<void> | null = null;
	private configureDirty = false;
	private readonly buildController = new AbortController();
	private disposed = false;

	constructor(
		readonly context: AudioContext,
		private readonly channelCount: VoiceInputChannelCount,
		private readonly resolveConfig: () => VoiceInputConfig,
		private readonly onLevel: (level: VoiceInputLevel) => void = () => {},
		private readonly onGateFailure: () => void = () => {},
		private readonly onRuntimeChange: () => void = () => {},
	) {
		this.inputMix = context.createGain();
		this.inputMix.channelCount = channelCount;
		this.inputMix.channelCountMode = 'explicit';
		this.inputMix.channelInterpretation = 'speakers';
		this.slot = this.createPassthroughSlot(1);
		this.gate = context.createGain();
		this.volume = context.createGain();
		this.softClip = createVoiceSoftClipNode(context);
		this.output = context.createGain();
		this.observerSink = context.createGain();
		this.observerSink.gain.value = 0;
		this.observerSink.connect(this.output);
		this.slot.output.connect(this.gate);
		const config = resolveConfig();
		this.gate.gain.value = 1;
		this.volume.gain.value = inputVoiceVolumePercentToGain(config.inputVolumePercent);
		this.applyParameters(config);
	}

	setSource(track: MediaStreamTrack): void {
		this.replaceSource(track, this.context.createMediaStreamSource(new MediaStream([track])));
	}

	setSourceNode(track: MediaStreamTrack, source: MediaStreamAudioSourceNode): void {
		this.replaceSource(track, source);
	}

	clearSource(): void {
		this.source?.disconnect();
		this.source = null;
		this.sourceTrack = null;
	}

	private replaceSource(track: MediaStreamTrack, source: MediaStreamAudioSourceNode): void {
		if (this.disposed) {
			source.disconnect();
			return;
		}
		source.connect(this.inputMix);
		this.source?.disconnect();
		this.source = source;
		this.sourceTrack = track;
		this.gateNode?.port.postMessage({type: 'reset'});
		this.softGain?.port.postMessage({type: 'reset'});
		this.onRuntimeChange();
	}

	private recreateSource(): void {
		const track = this.sourceTrack;
		if (track?.readyState !== 'live') return;
		try {
			this.setSource(track);
		} catch (error) {
			logger.debug('Could not recreate the voice input source after a suppression build', {error});
		}
	}

	reportRuntime(owner: object): void {
		if (this.disposed || !this.sourceTrack) return;
		const backend =
			this.slot.key === 'passthrough' ? readCaptureNoiseSuppressionBackend(this.sourceTrack) : this.slot.key;
		NoiseSuppressionAvailability.setVoiceInputRuntime(owner, backend, this.sourceTrack.getSettings(), this.context);
	}

	private readLevelRms(): number {
		return this.level?.rms ?? 0;
	}

	configure(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.configureDirty = true;
		this.configureRun ??= Promise.resolve().then(() => this.drainConfigure());
		return this.configureRun;
	}

	loadGate(): Promise<void> {
		this.gateLoad ??= this.installGate();
		return this.gateLoad;
	}

	private async drainConfigure(): Promise<void> {
		try {
			void this.loadGate();
			while (!this.disposed && this.configureDirty) {
				this.configureDirty = false;
				const config = this.resolveConfig();
				this.applyParameters(config);
				if (this.isPipelineV2Enabled(config) && !this.pipelineV2Failed) {
					this.pipelineV2Load ??= this.installPipelineV2();
					await this.pipelineV2Load;
					if (this.disposed) return;
					this.applyParameters(this.resolveConfig());
				}
				const key = this.resolveSlotKey(config.backend);
				if (
					key === this.slot.key &&
					(this.slot.suppressionStrength === undefined || this.slot.suppressionStrength === config.suppressionStrength)
				)
					continue;
				const slot = this.reviveRetiringSlot(key, config.suppressionStrength) ?? (await this.buildSlot(key));
				if (!slot) continue;
				if (this.disposed) {
					slot.dispose();
					return;
				}
				if (this.resolveSlotKey(this.resolveConfig().backend) !== key) {
					this.retireSlot(slot);
					this.configureDirty = true;
					continue;
				}
				this.swapSlot(slot);
			}
		} finally {
			this.configureRun = null;
		}
	}

	private resolveSlotKey(backend: VoiceNoiseSuppressionBackend): SuppressionSlotKey {
		if (this.channelCount === 2) return 'passthrough';
		const engine = getNoiseSuppressionBackendDescriptor(backend).engine;
		if (engine === 'deep_filter') return 'deep_filter';
		if (engine === 'worklet') return backend as NoiseSuppressionWorkletBackend;
		return 'passthrough';
	}

	private gateConfig(config: VoiceInputConfig): VoiceActivityGateConfig {
		const pipelineV2Enabled = this.isPipelineV2Enabled(config) && !this.pipelineV2Failed;
		return {
			pipelineV2Enabled,
			apply: config.gateEnabled && this.channelCount === 1,
			auto: config.gateAuto,
			manualThresholdRms: config.gateThresholdRms,
			...(pipelineV2Enabled ? {tuning: config.pipelineV2Tuning ?? VOICE_PIPELINE_TUNING} : {}),
		};
	}

	private isPipelineV2Enabled(config: VoiceInputConfig): boolean {
		return config.pipelineV2Enabled === true && this.channelCount === 1 && config.processingMode !== 'studio';
	}

	private async installPipelineV2(): Promise<void> {
		try {
			await this.loadGate();
			if (this.disposed || !this.gateNode) return;
			await loadVoiceActivityGate(this.context, this.buildController.signal, true);
			await loadVoiceSoftGain(this.context, this.buildController.signal);
			if (this.disposed || !this.gateNode) return;
			this.highpass = this.context.createBiquadFilter();
			this.highpass.type = 'highpass';
			this.highpass.frequency.value = VOICE_PIPELINE_TUNING.highpassHz;
			this.highpass.Q.value = VOICE_PIPELINE_TUNING.highpassQ;
			this.softGain = createVoiceSoftGain(
				this.context,
				() => this.failPipelineV2(),
				(processingMs, audioMs) => this.reportProcessingHealth('gain', processingMs, audioMs),
				this.resolveConfig().pipelineV2Tuning,
			);
		} catch (error) {
			if (this.disposed || this.buildController.signal.aborted) return;
			logger.warn('Voice pipeline could not start; keeping the previous input chain', {error});
			this.failPipelineV2();
		}
	}

	private failPipelineV2(): void {
		if (this.disposed || this.pipelineV2Failed) return;
		this.pipelineV2Failed = true;
		logger.warn('Voice pipeline failed; restoring the previous input chain');
		this.applyParameters(this.resolveConfig());
		this.destroyPipelineV2();
		NoiseSuppressionAvailability.markPipelineV2Failed();
	}

	private destroyPipelineV2(): void {
		this.highpass?.disconnect();
		this.highpass = null;
		if (!this.softGain) return;
		this.softGain.onprocessorerror = null;
		this.softGain.port.onmessage = null;
		this.softGain.port.postMessage({type: 'dispose'});
		this.softGain.port.close();
		this.softGain.disconnect();
		this.softGain = null;
	}

	private applyParameters(config: VoiceInputConfig): void {
		this.routeOutput(config);
		this.slot.configureHealth?.(this.isPipelineV2Enabled(config) && !this.pipelineV2Failed);
		this.configureProcessingHealth();
		this.volume.gain.setTargetAtTime(
			inputVoiceVolumePercentToGain(config.inputVolumePercent),
			this.context.currentTime,
			VOLUME_TIME_CONSTANT,
		);
		if (this.gateNode) this.gateNode.port.postMessage({type: 'config', ...this.gateConfig(config)});
		if (this.pipelineV2Routed)
			this.softGain?.port.postMessage({type: 'config', tuning: config.pipelineV2Tuning ?? VOICE_PIPELINE_TUNING});
	}

	private routeOutput(config: VoiceInputConfig): void {
		const directInput = config.processingMode === 'studio';
		const pipelineV2 =
			this.isPipelineV2Enabled(config) &&
			!this.pipelineV2Failed &&
			!!this.gateNode &&
			!!this.highpass &&
			!!this.softGain;
		if (directInput === this.directInput && pipelineV2 === this.pipelineV2Routed) return;
		this.directInput = directInput;
		this.pipelineV2Routed = pipelineV2;
		disconnectEdge(this.inputMix, this.volume);
		disconnectEdge(this.gate, this.volume);
		if (this.gateNode) {
			disconnectEdge(this.gateNode, this.volume);
			disconnectEdge(this.gateNode, this.observerSink);
			if (this.highpass) disconnectEdge(this.gateNode, this.highpass);
			if (this.softGain) disconnectEdge(this.gateNode, this.softGain);
		}
		this.highpass?.disconnect();
		this.softGain?.disconnect();
		this.softGain?.port.postMessage({type: 'configure-health', enabled: pipelineV2});
		this.volume.disconnect();
		this.softClip?.output.disconnect();
		if (directInput) {
			// Studio keeps the selected gain, but sends neither the gate's lookahead
			// nor the soft clip. The worklet remains a silent speaking observer.
			this.inputMix.connect(this.volume);
			this.volume.connect(this.output);
			this.gateNode?.connect(this.observerSink);
		} else {
			if (pipelineV2) {
				this.gateNode!.connect(this.highpass!);
				this.highpass!.connect(this.softGain!);
				this.gateNode!.connect(this.softGain!, 1, 1);
				this.softGain!.port.postMessage({type: 'reset'});
				this.softGain!.connect(this.volume);
			} else (this.gateNode ?? this.gate).connect(this.volume);
			if (this.softClip) {
				this.volume.connect(this.softClip.input);
				this.softClip.output.connect(this.output);
			} else this.volume.connect(this.output);
		}
	}

	private async installGate(): Promise<void> {
		try {
			await loadVoiceActivityGate(this.context, this.buildController.signal);
			if (this.disposed) return;
			const node = createVoiceActivityGate(
				this.context,
				this.channelCount,
				this.gateConfig(this.resolveConfig()),
				(level) => {
					if (this.disposed) return;
					this.level = level;
					reportVoiceInputLevel(this.context, level.contextTime);
					if (level.processingMs !== undefined && level.audioMs !== undefined)
						this.reportProcessingHealth('gate', level.processingMs, level.audioMs);
					this.onLevel(level);
				},
				() => this.failGate(),
			);
			this.gateNode = node;
			disconnectEdge(this.gate, this.volume);
			this.gate.connect(node);
			this.directInput = null;
			this.routeOutput(this.resolveConfig());
			this.gate.gain.value = 1;
		} catch (error) {
			if (this.disposed || this.buildController.signal.aborted) return;
			logger.warn('Voice activity gate could not start', {error});
			this.failGate();
		}
	}

	private failGate(): void {
		if (this.disposed || this.gateFailed) return;
		this.gateFailed = true;
		discardVoiceInputContext(this.context);
		this.destroyGate();
		this.gate.disconnect();
		this.directInput = null;
		this.routeOutput(this.resolveConfig());
		this.gate.gain.value = 1;
		this.onGateFailure();
	}

	private destroyGate(): void {
		const node = this.gateNode;
		if (!node) return;
		disconnectEdge(this.gate, node);
		node.onprocessorerror = null;
		node.port.onmessage = null;
		node.port.postMessage({type: 'dispose'});
		node.port.close();
		node.disconnect();
		this.gateNode = null;
	}

	private processingBackend(): VoiceNoiseSuppressionBackend {
		if (this.slot.key !== 'passthrough') return this.slot.key;
		return this.sourceTrack ? readCaptureNoiseSuppressionBackend(this.sourceTrack) : 'standard';
	}

	private configureProcessingHealth(reset = false): void {
		const sources: Array<'filter' | 'gate' | 'gain'> = [];
		if (this.isPipelineV2Enabled(this.resolveConfig()) && !this.pipelineV2Failed) {
			if (this.slot.key === 'deep_filter' || this.slot.key === 'rnnoise') sources.push('filter');
			if (this.gateNode) sources.push('gate');
			if (this.pipelineV2Routed) sources.push('gain');
		}
		NoiseSuppressionAvailability.configureProcessingHealth(this, this.processingBackend(), sources, reset);
	}

	private reportProcessingHealth(source: 'filter' | 'gate' | 'gain', processingMs: number, audioMs: number): void {
		if (this.disposed) return;
		this.configureProcessingHealth();
		const backend = this.processingBackend();
		const overBudget = NoiseSuppressionAvailability.reportProcessingHealth(
			backend,
			processingMs,
			audioMs,
			this.isPipelineV2Enabled(this.resolveConfig()) && !this.pipelineV2Failed,
			source,
			this,
		);
		if (overBudget && backend !== 'deep_filter' && backend !== 'rnnoise')
			this.gateNode?.port.postMessage({type: 'disable-vad'});
	}

	private createPassthroughSlot(initialGain: number): SuppressionSlot {
		const output = this.context.createGain();
		output.gain.value = initialGain;
		this.inputMix.connect(output);
		return {
			key: 'passthrough',
			output,
			dispose: () => {
				disconnectEdge(this.inputMix, output);
				output.disconnect();
			},
		};
	}

	private async buildSlot(key: SuppressionSlotKey): Promise<SuppressionSlot | null> {
		if (key === 'passthrough') return this.createPassthroughSlot(0);
		try {
			return key === 'deep_filter' ? await this.buildDeepFilterSlot() : await this.buildWorkletSlot(key);
		} catch (error) {
			if (!this.disposed && !isAbortError(error)) {
				logger.warn('Noise suppression could not start; keeping the current voice input chain', {backend: key, error});
			}
			return null;
		}
	}

	private async waitForSpeechPause(signal: AbortSignal): Promise<void> {
		const threshold = this.level?.thresholdRms ?? this.resolveConfig().gateThresholdRms;
		const deadline = performance.now() + PAUSE_WAIT_MAX_MS;
		let quietSince: number | null = null;
		while (!signal.aborted && performance.now() < deadline) {
			const at = performance.now();
			if (this.readLevelRms() >= threshold) quietSince = null;
			else if (at - (quietSince ??= at) >= PAUSE_MIN_MS) return;
			await new Promise((resolve) => setTimeout(resolve, PAUSE_POLL_MS));
		}
	}

	private async buildDeepFilterSlot(): Promise<SuppressionSlot> {
		const signal = this.buildController.signal;
		const suppressionStrength = this.resolveConfig().suppressionStrength;
		if (this.source && !hasIdleDeepFilterNode(this.context, suppressionStrength)) await this.waitForSpeechPause(signal);
		let slot: SuppressionSlot | null = null;
		const lease = await acquireDeepFilterNode(
			this.context,
			signal,
			() => void this.configure(),
			suppressionStrength,
			() => this.isPipelineV2Enabled(this.resolveConfig()),
			(processingMs, audioMs) => {
				if (slot === this.slot) this.reportProcessingHealth('filter', processingMs, audioMs);
			},
		);
		const output = this.context.createGain();
		output.gain.value = 0;
		const dispose = () => {
			disconnectEdge(this.inputMix, lease.node);
			disconnectEdge(lease.node, output);
			output.disconnect();
			lease.release();
		};
		this.inputMix.connect(lease.node);
		lease.node.connect(output);
		await lease.primed(signal);
		if (this.disposed) {
			dispose();
			throw new DOMException('Voice input graph disposed', 'AbortError');
		}
		if (lease.builtOverLiveSource) this.recreateSource();
		slot = {key: 'deep_filter', output, dispose, suppressionStrength};
		return slot;
	}

	private async buildWorkletSlot(backend: NoiseSuppressionWorkletBackend): Promise<SuppressionSlot> {
		const suppressionStrength = this.resolveConfig().suppressionStrength;
		let slot: SuppressionSlot | null = null;
		const worklet = await createNoiseSuppressionWorkletNode(this.context, backend, {
			signal: this.buildController.signal,
			suppressionStrength,
			pipelineV2Enabled: false,
			onHealth: (processingMs, audioMs) => {
				if (slot === this.slot) this.reportProcessingHealth('filter', processingMs, audioMs);
			},
			onRuntimeFailure: (error) => {
				logger.warn('Noise suppression worklet failed while running; using browser noise suppression', {
					backend,
					error,
				});
				NoiseSuppressionAvailability.markBackendFailed(backend, 'runtime', Date.now());
				void this.configure();
			},
		}).catch((error: unknown) => {
			if (!this.buildController.signal.aborted) {
				NoiseSuppressionAvailability.markBackendFailed(backend, 'build', Date.now());
			}
			throw error;
		});
		const output = this.context.createGain();
		output.gain.value = 0;
		this.inputMix.connect(worklet.node);
		worklet.node.connect(output);
		slot = {
			key: backend,
			configureHealth: (enabled) => worklet.node.port.postMessage({type: 'configure-health', enabled}),
			suppressionStrength: backend === 'gate' ? suppressionStrength : undefined,
			output,
			dispose: () => {
				disconnectEdge(this.inputMix, worklet.node);
				output.disconnect();
				worklet.dispose();
			},
		};
		return slot;
	}

	private swapSlot(next: SuppressionSlot): void {
		const previous = this.slot;
		previous.configureHealth?.(false);
		next.output.connect(this.gate);
		rampGain(next.output.gain, 1, this.context);
		rampGain(previous.output.gain, 0, this.context);
		this.slot = next;
		next.configureHealth?.(this.isPipelineV2Enabled(this.resolveConfig()) && !this.pipelineV2Failed);
		this.configureProcessingHealth(true);
		this.onRuntimeChange();
		this.gateNode?.port.postMessage({type: 'reset'});
		this.softGain?.port.postMessage({type: 'reset'});
		this.retireSlot(previous);
	}

	private retireSlot(slot: SuppressionSlot): void {
		this.retiringSlots.set(
			slot,
			setTimeout(() => {
				this.retiringSlots.delete(slot);
				slot.dispose();
			}, SLOT_RELEASE_DELAY_MS),
		);
	}

	private reviveRetiringSlot(key: SuppressionSlotKey, strength: number): SuppressionSlot | null {
		for (const [slot, timer] of this.retiringSlots) {
			if (slot.key !== key || (slot.suppressionStrength !== undefined && slot.suppressionStrength !== strength))
				continue;
			clearTimeout(timer);
			this.retiringSlots.delete(slot);
			return slot;
		}
		return null;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.buildController.abort(new DOMException('Voice input graph disposed', 'AbortError'));
		this.destroyGate();
		this.destroyPipelineV2();
		for (const [slot, timer] of this.retiringSlots) {
			clearTimeout(timer);
			slot.dispose();
		}
		this.retiringSlots.clear();
		this.slot.dispose();
		this.clearSource();
		this.inputMix.disconnect();
		this.gate.disconnect();
		this.volume.disconnect();
		this.observerSink.disconnect();
		this.output.disconnect();
		this.softClip?.input.disconnect();
		this.softClip?.output.disconnect();
	}
}

export interface VoiceInputProcessorEvents {
	onSourceRateChanged(processor: VoiceInputTrackProcessor): void;
	onGraphStalled(processor: VoiceInputTrackProcessor): void;
	onGraphFailed(processor: VoiceInputTrackProcessor): void;
}

export class VoiceInputTrackProcessor implements TrackProcessor<Track.Kind.Audio> {
	readonly name = 'fluxer-voice-input-processor';
	processedTrack?: MediaStreamTrack;
	private state: 'idle' | 'live' | 'destroyed' = 'idle';
	private hasRunningLevel = false;
	private lease: VoiceInputContextLease | null = null;
	private graph: VoiceInputGraph | null = null;
	private destination: MediaStreamAudioDestinationNode | null = null;
	private stallTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly onContextStateChange = () => this.watchContextState();

	constructor(
		private readonly channelCount: VoiceInputChannelCount,
		private readonly events: VoiceInputProcessorEvents,
	) {}

	async init(opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> {
		if (this.state !== 'idle') throw new Error(`Voice input processor cannot start while ${this.state}`);
		const acquired = acquireVoiceInputSource(opts.track);
		if (!acquired) throw new Error('Voice input processor has no AudioContext');
		this.lease = acquired.lease;
		const context = acquired.lease.context;
		this.graph = new VoiceInputGraph(
			context,
			this.channelCount,
			resolveVoiceInputConfig,
			() => this.noteLevel(),
			() => this.events.onGraphFailed(this),
			() => this.reportRuntime(),
		);
		this.graph.setSourceNode(opts.track, acquired.source);
		await this.graph.loadGate();
		if (this.state !== 'idle') throw new Error(`Voice input processor cannot start while ${this.state}`);
		this.destination = context.createMediaStreamDestination();
		this.destination.channelCount = this.channelCount;
		this.destination.channelCountMode = 'explicit';
		this.destination.channelInterpretation = 'speakers';
		this.graph.output.connect(this.destination);
		const processedTrack = this.destination.stream.getAudioTracks()[0];
		if (!processedTrack) throw new Error('Voice input processor produced no output track');
		this.processedTrack = processedTrack;
		this.state = 'live';
		this.reportRuntime();
		context.addEventListener('statechange', this.onContextStateChange);
		this.watchContextState();
		void this.graph.configure();
	}

	async restart(opts: ProcessorOptions<Track.Kind.Audio>): Promise<void> {
		const graph = this.graph;
		if (this.state !== 'live' || !graph) return;
		try {
			graph.setSource(opts.track);
		} catch (error) {
			logger.warn('Voice input cannot read the restarted microphone in its AudioContext', {error});
			graph.clearSource();
			this.events.onSourceRateChanged(this);
		}
	}

	configure(): Promise<void> {
		if (this.state !== 'live' || !this.graph) return Promise.resolve();
		return this.graph.configure();
	}

	reportRuntime(): void {
		if (this.state === 'live') this.graph?.reportRuntime(this);
	}

	private noteLevel(): void {
		if (this.state !== 'live' || this.hasRunningLevel || this.lease?.context.state !== 'running') return;
		this.hasRunningLevel = true;
		NoiseSuppressionAvailability.setVoiceInputGraphUnavailable(false);
	}

	private watchContextState(): void {
		const context = this.lease?.context;
		if (this.state !== 'live' || !context) return;
		if (context.state === 'running') {
			this.clearStallTimer();
			return;
		}
		this.stallTimer ??= setTimeout(() => {
			this.stallTimer = null;
			if (this.state === 'live' && context.state !== 'running') this.events.onGraphStalled(this);
		}, CONTEXT_STALL_TIMEOUT_MS);
	}

	private clearStallTimer(): void {
		if (this.stallTimer === null) return;
		clearTimeout(this.stallTimer);
		this.stallTimer = null;
	}

	async destroy(): Promise<void> {
		if (this.state === 'destroyed') return;
		this.state = 'destroyed';
		NoiseSuppressionAvailability.clearVoiceInputRuntime(this);
		this.clearStallTimer();
		this.lease?.context.removeEventListener('statechange', this.onContextStateChange);
		this.graph?.dispose();
		this.destination?.disconnect();
		if (this.processedTrack && this.processedTrack.readyState !== 'ended') this.processedTrack.stop();
		this.lease?.release();
		this.graph = null;
		this.destination = null;
		this.lease = null;
	}
}

export function readVoiceInputProcessor(
	track: {getProcessor(): unknown} | null | undefined,
): VoiceInputTrackProcessor | null {
	const processor = track?.getProcessor();
	return processor instanceof VoiceInputTrackProcessor ? processor : null;
}
