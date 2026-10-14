// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	getNoiseSuppressionBackendDescriptor,
	type VoiceNoiseSuppressionBackend,
} from '@app/features/voice/utils/noise_suppression/NoiseSuppressionBackends';
import {makeAutoObservable} from 'mobx';

type DeepFilterAssetState = 'idle' | 'loading' | 'ready';

export type NoiseSuppressionFailureReason =
	| 'assets'
	| 'model_encoding'
	| 'build'
	| 'runtime'
	| 'sample_rate'
	| 'cpu_budget';

type NoiseSuppressionFallback = 'loading' | 'failed' | 'cpu_budget';

interface NoiseSuppressionFailure {
	count: number;
	retryAtMs: number;
	reason: NoiseSuppressionFailureReason;
	active: boolean;
}

const FAILURE_BACKOFF_BASE_MS = 30_000;
const FAILURE_BACKOFF_MAX_MS = 15 * 60_000;
type ProcessingHealthSource = 'filter' | 'gate' | 'gain';
interface ProcessingHealthWindow {
	backend: VoiceNoiseSuppressionBackend;
	sources: ReadonlyArray<ProcessingHealthSource>;
	baselineFirst: boolean;
	overBudget: number;
	reports: Map<
		ProcessingHealthSource,
		{processingMs: number; audioMs: number; baselineProcessingMs: number; baselineAudioMs: number}
	>;
}

class NoiseSuppressionAvailability {
	deepFilterAssets: DeepFilterAssetState = 'idle';
	failures = new Map<VoiceNoiseSuppressionBackend, NoiseSuppressionFailure>();
	inputContextRate: number | null = null;
	voiceInputGraphUnavailable = false;
	pipelineV2Failed = false;
	runningBackend: VoiceNoiseSuppressionBackend | null = null;
	captureSettings: MediaTrackSettings | null = null;
	deepFilterLevels: {inputRms: number; outputRms: number; contextTime: number} | null = null;
	private runtimeOwner: object | null = null;
	private runtimeContext: BaseAudioContext | null = null;
	private listeners = new Set<() => void>();
	private processingHealth = new WeakMap<object, Map<string, ProcessingHealthWindow>>();

	constructor() {
		makeAutoObservable<this, 'listeners' | 'notifyListeners' | 'runtimeOwner' | 'runtimeContext' | 'processingHealth'>(
			this,
			{listeners: false, notifyListeners: false, runtimeOwner: false, runtimeContext: false, processingHealth: false},
			{autoBind: true},
		);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notifyListeners(): void {
		for (const listener of [...this.listeners]) {
			listener();
		}
	}

	isBackendUsable(backend: VoiceNoiseSuppressionBackend): boolean {
		if (this.failures.get(backend)?.active) return false;
		const descriptor = getNoiseSuppressionBackendDescriptor(backend);
		if (descriptor.engine === 'worklet' || descriptor.engine === 'deep_filter') {
			if (this.voiceInputGraphUnavailable) return false;
			const rates = descriptor.supportedSampleRates;
			if (this.inputContextRate !== null && rates !== null && !rates.includes(this.inputContextRate)) return false;
		}
		return backend !== 'deep_filter' || this.deepFilterAssets === 'ready';
	}

	resolveEffectiveBackend(
		requested: VoiceNoiseSuppressionBackend,
		pipelineV2Enabled = false,
	): VoiceNoiseSuppressionBackend {
		if (this.isBackendUsable(requested)) return requested;
		if (
			pipelineV2Enabled &&
			requested === 'deep_filter' &&
			this.failures.get(requested)?.reason === 'cpu_budget' &&
			this.isBackendUsable('rnnoise')
		)
			return 'rnnoise';
		return 'standard';
	}

	getFallback(requested: VoiceNoiseSuppressionBackend): NoiseSuppressionFallback | null {
		if (this.failures.get(requested)?.active && this.failures.get(requested)?.reason === 'cpu_budget')
			return 'cpu_budget';
		if (this.failures.get(requested)?.active) return 'failed';
		if (requested === 'deep_filter' && this.deepFilterAssets !== 'ready') return 'loading';
		if (!this.isBackendUsable(requested)) return 'failed';
		return null;
	}

	setVoiceInputRuntime(
		owner: object,
		backend: VoiceNoiseSuppressionBackend,
		captureSettings: MediaTrackSettings,
		context: BaseAudioContext | null,
	): void {
		if (backend !== 'deep_filter' || this.runtimeContext !== context) this.deepFilterLevels = null;
		this.runtimeOwner = owner;
		this.runtimeContext = context;
		this.runningBackend = backend;
		this.captureSettings = captureSettings;
	}

	clearVoiceInputRuntime(owner: object): void {
		if (this.runtimeOwner !== owner) return;
		this.runtimeOwner = null;
		this.runtimeContext = null;
		this.runningBackend = null;
		this.captureSettings = null;
		this.deepFilterLevels = null;
	}

	setDeepFilterLevels(context: BaseAudioContext, inputRms: number, outputRms: number, contextTime: number): void {
		if (this.runtimeContext !== context || this.runningBackend !== 'deep_filter') return;
		this.deepFilterLevels = {inputRms, outputRms, contextTime};
	}

	setDeepFilterAssetState(state: DeepFilterAssetState): void {
		if (this.deepFilterAssets === state) return;
		this.deepFilterAssets = state;
		this.notifyListeners();
	}

	setInputContextRate(rate: number): void {
		if (this.inputContextRate === rate) return;
		this.inputContextRate = rate;
		this.notifyListeners();
	}

	setVoiceInputGraphUnavailable(unavailable: boolean): void {
		if (this.voiceInputGraphUnavailable === unavailable) return;
		this.voiceInputGraphUnavailable = unavailable;
		this.notifyListeners();
	}

	markBackendFailed(backend: VoiceNoiseSuppressionBackend, reason: NoiseSuppressionFailureReason, nowMs: number): void {
		if (this.failures.get(backend)?.active && this.failures.get(backend)?.reason === 'cpu_budget') return;
		const count = (this.failures.get(backend)?.count ?? 0) + 1;
		const backoffMs = Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** (count - 1), FAILURE_BACKOFF_MAX_MS);
		this.failures.set(backend, {count, retryAtMs: nowMs + backoffMs, reason, active: true});
		this.notifyListeners();
	}

	clearBackendFailure(backend: VoiceNoiseSuppressionBackend): void {
		if (this.failures.get(backend)?.active && this.failures.get(backend)?.reason === 'cpu_budget') return;
		if (!this.failures.delete(backend)) return;
		this.notifyListeners();
	}

	markPipelineV2Failed(): void {
		if (this.pipelineV2Failed) return;
		this.pipelineV2Failed = true;
		this.notifyListeners();
	}

	releaseExpiredFailures(nowMs: number, resetCpuFailures = false): void {
		this.processingHealth = new WeakMap();
		let changed = resetCpuFailures && this.pipelineV2Failed;
		if (resetCpuFailures) this.pipelineV2Failed = false;
		for (const [backend, failure] of this.failures) {
			if (!failure.active) continue;
			if (failure.reason === 'cpu_budget' ? !resetCpuFailures : failure.retryAtMs > nowMs) continue;
			this.failures.set(backend, {...failure, active: false});
			changed = true;
		}
		if (changed) this.notifyListeners();
	}

	configureProcessingHealth(
		owner: object,
		backend: VoiceNoiseSuppressionBackend,
		sources: ReadonlyArray<ProcessingHealthSource>,
		reset = false,
	): void {
		const previous = this.processingHealth.get(owner)?.get('graph');
		if (
			!reset &&
			previous?.backend === backend &&
			previous.sources.length === sources.length &&
			sources.every((source) => previous.sources.includes(source))
		)
			return;
		this.processingHealth.set(
			owner,
			new Map([['graph', {backend, sources: [...sources], baselineFirst: true, overBudget: 0, reports: new Map()}]]),
		);
	}

	reportProcessingHealth(
		backend: VoiceNoiseSuppressionBackend,
		processingMs: number,
		audioMs: number,
		pipelineV2Enabled: boolean,
		source: ProcessingHealthSource = 'filter',
		owner: object = this,
	): boolean {
		if (!pipelineV2Enabled) {
			this.processingHealth.delete(owner);
			return false;
		}
		if (!Number.isFinite(processingMs) || !Number.isFinite(audioMs) || processingMs < 0 || audioMs <= 0) return false;
		let health = this.processingHealth.get(owner);
		if (!health) {
			health = new Map();
			this.processingHealth.set(owner, health);
		}
		let window = health.get('graph');
		if (window && (window.backend !== backend || !window.sources.includes(source))) return false;
		if (!window) {
			const key = `${backend}:${source}`;
			window = health.get(key);
			if (!window) {
				window = {backend, sources: [source], baselineFirst: false, overBudget: 0, reports: new Map()};
				health.set(key, window);
			}
		}
		let previous = window.reports.get(source);
		if (previous && (audioMs < previous.audioMs || processingMs < previous.processingMs)) {
			window.reports.clear();
			window.overBudget = 0;
			previous = undefined;
		}
		window.reports.set(source, {
			processingMs,
			audioMs,
			baselineProcessingMs: previous?.baselineProcessingMs ?? (window.baselineFirst ? processingMs : 0),
			baselineAudioMs: previous?.baselineAudioMs ?? (window.baselineFirst ? audioMs : 0),
		});
		let totalWork = 0;
		let windowAudio = 0;
		for (const stage of window.sources) {
			const report = window.reports.get(stage);
			if (!report || report.audioMs - report.baselineAudioMs < 500) return false;
			totalWork += report.processingMs - report.baselineProcessingMs;
			windowAudio = Math.max(windowAudio, report.audioMs - report.baselineAudioMs);
		}
		// Use the longest fresh interval so asynchronous reporting cannot inflate total load.
		window.overBudget = totalWork / windowAudio > 0.8 ? window.overBudget + 1 : 0;
		for (const report of window.reports.values()) {
			report.baselineProcessingMs = report.processingMs;
			report.baselineAudioMs = report.audioMs;
		}
		if (window.overBudget >= 3 && (backend === 'deep_filter' || backend === 'rnnoise'))
			this.markBackendFailed(backend, 'cpu_budget', Date.now());
		return window.overBudget >= 3;
	}
}

export default new NoiseSuppressionAvailability();
