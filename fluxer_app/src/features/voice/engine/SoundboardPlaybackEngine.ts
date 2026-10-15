// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/features/platform/utils/AppLogger';
import {acquireSharedVoiceAudioContext} from '@app/features/voice/engine/VoiceSharedAudioContext';

const logger = new Logger('SoundboardPlaybackEngine');
const MAX_SOURCES = 2;
const MAX_JOBS = 2;
const MAX_CACHE_ENTRIES = 16;
const MAX_PCM_BYTES = 32 * 1024 * 1024;
const MAX_ENCODED_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 512000;
const MAX_DURATION_SECONDS = 5.2;
const MAX_EVENT_AGE_MS = 5000;
const MAX_EVENT_IDS = 256;
const JOB_TIMEOUT_MS = 10000;

export interface SoundboardPlaybackParams {
	eventId: string;
	guildId: string;
	channelId: string;
	actorId: string;
	actorSessionId: string;
	recipientConnectionId: string;
	recipientSoundboardEpoch: number;
	serverTime: number;
	assetVersion: string;
	url: string;
	sizeBytes: number;
	durationMs: number;
	volume: number;
}

export interface SoundboardPlaybackDependencies {
	fetch: (url: string, options: RequestInit) => Promise<Response>;
	acquireContext: () => {context: AudioContext; release: () => void} | null;
	isEligible: (params: SoundboardPlaybackParams) => boolean;
	getSessionKey: () => string | null;
	subscribe: (listener: () => void) => () => void;
	now: () => number;
}

interface PlaybackJob {
	params: SoundboardPlaybackParams;
	controller: AbortController;
	sessionKey: string;
	generation: number;
	release: () => void;
	timer: ReturnType<typeof setTimeout> | null;
	pcmReservation: number;
}

interface ActiveSource {
	params: SoundboardPlaybackParams;
	sessionKey: string;
	source: AudioBufferSourceNode;
	gain: GainNode;
	release: () => void;
}

export class SoundboardPlaybackEngine {
	private dependencies: SoundboardPlaybackDependencies;
	private unsubscribe: (() => void) | null = null;
	private sessionKey: string | null = null;
	private generation = 0;
	private disposed = false;
	private readonly jobs = new Set<PlaybackJob>();
	private readonly sources = new Set<ActiveSource>();
	private readonly cache = new Map<string, AudioBuffer>();
	private readonly eventIds = new Map<string, number>();
	private pcmBytes = 0;

	constructor(dependencies: Partial<SoundboardPlaybackDependencies> = {}) {
		this.dependencies = {
			fetch: (url, options) => fetch(url, options),
			acquireContext: acquireSharedVoiceAudioContext,
			isEligible: () => false,
			getSessionKey: () => null,
			subscribe: () => () => {},
			now: () => performance.now(),
			...dependencies,
		};
		this.sessionKey = this.dependencies.getSessionKey();
		this.unsubscribe = this.dependencies.subscribe(() => this.stateChanged());
	}

	configure(dependencies: Partial<SoundboardPlaybackDependencies>): void {
		this.invalidate();
		this.unsubscribe?.();
		this.dependencies = {...this.dependencies, ...dependencies};
		this.disposed = false;
		this.sessionKey = this.dependencies.getSessionKey();
		this.unsubscribe = this.dependencies.subscribe(() => this.stateChanged());
	}

	private current(params: SoundboardPlaybackParams, sessionKey: string): boolean {
		return !this.disposed && this.dependencies.getSessionKey() === sessionKey && this.dependencies.isEligible(params);
	}

	private validJob(job: PlaybackJob): boolean {
		return (
			job.generation === this.generation && !job.controller.signal.aborted && this.current(job.params, job.sessionKey)
		);
	}

	private cancelJob(job: PlaybackJob): void {
		job.controller.abort();
		if (job.timer !== null) clearTimeout(job.timer);
		job.timer = null;
		job.release();
	}

	private finishSource(active: ActiveSource, stop: boolean): void {
		if (!this.sources.delete(active)) return;
		active.source.onended = null;
		if (stop) {
			try {
				active.source.stop();
			} catch (error) {
				logger.debug('Soundboard source already stopped', {error});
			}
		}
		try {
			active.source.disconnect();
		} catch (error) {
			logger.debug('Soundboard source disconnect failed', {error});
		}
		active.source.buffer = null;
		try {
			active.gain.disconnect();
		} catch (error) {
			logger.debug('Soundboard gain disconnect failed', {error});
		}
		active.release();
	}

	private bufferBytes(buffer: AudioBuffer): number {
		return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
	}

	private reserveCache(bytes: number, addingEntry: boolean): boolean {
		const reserved = [...this.jobs].reduce((total, job) => total + job.pcmReservation, 0);
		while (this.pcmBytes + reserved + bytes > MAX_PCM_BYTES || (addingEntry && this.cache.size >= MAX_CACHE_ENTRIES)) {
			const oldest = [...this.cache.keys()].find(
				(key) => ![...this.sources].some((active) => active.params.assetVersion === key),
			);
			if (!oldest) return false;
			this.pcmBytes -= this.bufferBytes(this.cache.get(oldest)!);
			this.cache.delete(oldest);
		}
		return true;
	}

	private validBuffer(buffer: AudioBuffer, sampleRate: number, maxDecodeBytes: number): boolean {
		return (
			Number.isFinite(buffer.duration) &&
			buffer.duration > 0 &&
			buffer.duration <= MAX_DURATION_SECONDS &&
			Number.isInteger(buffer.numberOfChannels) &&
			buffer.numberOfChannels >= 1 &&
			buffer.numberOfChannels <= 2 &&
			Number.isFinite(buffer.sampleRate) &&
			buffer.sampleRate > 0 &&
			buffer.sampleRate <= sampleRate &&
			Number.isInteger(buffer.length) &&
			buffer.length > 0 &&
			buffer.length <= Math.ceil(MAX_DURATION_SECONDS * buffer.sampleRate) &&
			this.bufferBytes(buffer) <= maxDecodeBytes
		);
	}

	private async readEncoded(response: Response, job: PlaybackJob): Promise<ArrayBuffer | null> {
		const declaredLength = response.headers.get('content-length');
		if (
			!response.ok ||
			(declaredLength !== null && (!Number.isFinite(Number(declaredLength)) || Number(declaredLength) > MAX_FILE_BYTES))
		) {
			await response.body?.cancel();
			return null;
		}
		const reader = response.body?.getReader();
		if (!reader) return null;
		const chunks: Array<Uint8Array> = [];
		let bytes = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (!this.validJob(job)) return null;
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > MAX_FILE_BYTES) return null;
				chunks.push(chunk.value);
			}
			if (bytes === 0 || bytes !== job.params.sizeBytes) return null;
			const encoded = new Uint8Array(bytes);
			let offset = 0;
			for (const chunk of chunks) {
				encoded.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return encoded.buffer;
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}

	async play(params: SoundboardPlaybackParams): Promise<void> {
		this.stateChanged();
		const sessionKey = this.dependencies.getSessionKey();
		const now = this.dependencies.now();
		if (
			!sessionKey ||
			!this.current(params, sessionKey) ||
			!Number.isFinite(params.serverTime) ||
			!params.eventId ||
			!/^[a-f0-9]{64}$/.test(params.assetVersion) ||
			!Number.isInteger(params.sizeBytes) ||
			params.sizeBytes <= 0 ||
			params.sizeBytes > MAX_FILE_BYTES ||
			!Number.isFinite(params.durationMs) ||
			params.durationMs <= 0 ||
			params.durationMs > MAX_DURATION_SECONDS * 1000 ||
			!Number.isFinite(params.volume) ||
			params.volume < 0 ||
			params.volume > 1 ||
			this.sources.size >= MAX_SOURCES ||
			this.jobs.size >= MAX_JOBS ||
			(this.jobs.size + 1) * MAX_FILE_BYTES * 2 > MAX_ENCODED_BYTES
		)
			return;
		for (const [eventId, timestamp] of this.eventIds) {
			if (now - timestamp > MAX_EVENT_AGE_MS) this.eventIds.delete(eventId);
		}
		if (this.eventIds.has(params.eventId)) return;
		this.eventIds.set(params.eventId, now);
		while (this.eventIds.size > MAX_EVENT_IDS) this.eventIds.delete(this.eventIds.keys().next().value!);
		const lease = this.dependencies.acquireContext();
		if (!lease) return;
		let released = false;
		const release = () => {
			if (!released) {
				released = true;
				lease.release();
			}
		};
		const job: PlaybackJob = {
			params,
			controller: new AbortController(),
			sessionKey,
			generation: this.generation,
			release,
			timer: null,
			pcmReservation: 0,
		};
		this.jobs.add(job);
		job.timer = setTimeout(() => this.cancelJob(job), JOB_TIMEOUT_MS);
		let active: ActiveSource | null = null;
		let source: AudioBufferSourceNode | null = null;
		let gain: GainNode | null = null;
		try {
			let buffer = this.cache.get(params.assetVersion);
			if (buffer) {
				this.cache.delete(params.assetVersion);
				this.cache.set(params.assetVersion, buffer);
			} else {
				const response = await this.dependencies.fetch(params.url, {
					signal: job.controller.signal,
					cache: 'force-cache',
					credentials: 'omit',
				});
				if (!this.validJob(job)) {
					await response.body?.cancel();
					return;
				}
				const encoded = await this.readEncoded(response, job);
				const maxDecodeBytes =
					Math.ceil(MAX_DURATION_SECONDS * lease.context.sampleRate) * 2 * Float32Array.BYTES_PER_ELEMENT;
				if (
					!encoded ||
					!this.validJob(job) ||
					!Number.isFinite(maxDecodeBytes) ||
					maxDecodeBytes <= 0 ||
					!this.reserveCache(maxDecodeBytes, false)
				)
					return;
				job.pcmReservation = maxDecodeBytes;
				buffer = await lease.context.decodeAudioData(encoded);
				job.pcmReservation = 0;
				if (!this.validJob(job) || !this.validBuffer(buffer, lease.context.sampleRate, maxDecodeBytes)) return;
				const previous = this.cache.get(params.assetVersion);
				if (previous) buffer = previous;
				else {
					if (!this.reserveCache(this.bufferBytes(buffer), true)) return;
					this.cache.set(params.assetVersion, buffer);
					this.pcmBytes += this.bufferBytes(buffer);
				}
			}
			if (!this.validJob(job) || this.sources.size >= MAX_SOURCES || lease.context.state === 'closed') return;
			source = lease.context.createBufferSource();
			source.buffer = buffer;
			gain = lease.context.createGain();
			gain.gain.value = params.volume;
			source.connect(gain);
			gain.connect(lease.context.destination);
			active = {params, sessionKey, source, gain, release};
			this.sources.add(active);
			const started = active;
			source.onended = () => this.finishSource(started, false);
			source.start();
		} catch (error) {
			logger.debug('Soundboard playback failed', {error});
			if (active) this.finishSource(active, true);
			else {
				if (source) {
					source.onended = null;
					source.buffer = null;
					try {
						source.disconnect();
					} catch (cleanupError) {
						logger.debug('Soundboard source disconnect failed', {error: cleanupError});
					}
				}
				try {
					gain?.disconnect();
				} catch (cleanupError) {
					logger.debug('Soundboard gain disconnect failed', {error: cleanupError});
				}
			}
		} finally {
			if (job.timer !== null) clearTimeout(job.timer);
			job.timer = null;
			this.jobs.delete(job);
			if (!active || !this.sources.has(active)) release();
		}
	}

	invalidate(): void {
		this.generation++;
		for (const job of this.jobs) this.cancelJob(job);
		for (const active of this.sources) this.finishSource(active, true);
		this.cache.clear();
		this.pcmBytes = 0;
		this.eventIds.clear();
	}

	stateChanged(): void {
		const sessionKey = this.dependencies.getSessionKey();
		if (this.sessionKey !== sessionKey) {
			this.invalidate();
			this.sessionKey = sessionKey;
		}
		for (const job of this.jobs) if (!this.validJob(job)) this.cancelJob(job);
		for (const active of this.sources)
			if (!this.current(active.params, active.sessionKey)) this.finishSource(active, true);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.invalidate();
		this.unsubscribe?.();
		this.unsubscribe = null;
	}
}

export default new SoundboardPlaybackEngine();
