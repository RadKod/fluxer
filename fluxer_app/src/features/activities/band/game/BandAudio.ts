// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import type {AudioClockAnchor, SongStartSchedule} from '@app/features/activities/band/engine/SessionClock';
import type {AudioStem, StemRole} from '@app/features/activities/band/engine/SongPackage';
import type {DuckDepth} from '@app/features/activities/band/game/BandSettings';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {acquireSharedVoiceAudioContext} from '@app/features/voice/engine/VoiceSharedAudioContext';

const logger = new Logger('BandAudio');

// A missed note drops that part's stem to a share of its level, holds it there and brings it back quickly, Rock
// Band style. Strong is near silence for about 0.6 s, so a miss is heard; light is the gentler first version.
export const DUCK_SHAPES: Readonly<
	Record<DuckDepth, {readonly level: number; readonly holdS: number; readonly releaseS: number}>
> = {
	strong: {level: 0.05, holdS: 0.48, releaseS: 0.12},
	light: {level: 0.15, holdS: 0.4, releaseS: 0.15},
};
const DUCK_ATTACK_S = 0.03;
const CLICK_LENGTH_S = 0.05;
// Audio cannot be scheduled into the past; this is the least lead given on top of the output latency.
const MIN_START_LEAD_S = 0.25;

const PLAYABLE_ROLES: ReadonlyArray<StemRole> = [
	'guitar',
	'rhythm',
	'bass',
	'drums',
	'keys',
	'vocals',
	'backing',
	'crowd',
];

export interface GainPoint {
	readonly time: number;
	readonly value: number;
	readonly ramp: boolean;
}

// Gain automation for one duck starting at `now`: quick dip, hold, ease back. A duck during a duck restarts the
// hold from the current (already low) value, so a run of misses keeps the stem down.
export function duckEnvelope(
	now: number,
	level: number,
	current: number,
	depth: DuckDepth = 'strong',
): ReadonlyArray<GainPoint> {
	const shape = DUCK_SHAPES[depth];
	const low = level * shape.level;
	const dipEnd = now + DUCK_ATTACK_S;
	return [
		{time: now, value: current, ramp: false},
		{time: dipEnd, value: low, ramp: true},
		{time: dipEnd + shape.holdS, value: low, ramp: false},
		{time: dipEnd + shape.holdS + shape.releaseS, value: level, ramp: true},
	];
}

export function applyGainPoints(param: AudioParam, points: ReadonlyArray<GainPoint>): void {
	const [first] = points;
	if (!first) return;
	param.cancelScheduledValues(first.time);
	for (const point of points) {
		if (point.ramp) param.linearRampToValueAtTime(point.value, point.time);
		else param.setValueAtTime(point.value, point.time);
	}
}

// The context time being heard right now, tied to performance.now(). An output timestamp already has the output
// latency in it; without one, both the context's own processing latency and the device's output latency are taken
// off the render clock.
export function readAudioAnchor(context: AudioContext): AudioClockAnchor {
	const timeOrigin = performance.timeOrigin;
	const stamp = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : null;
	if (stamp?.contextTime !== undefined && stamp.performanceTime !== undefined && stamp.performanceTime > 0) {
		return {contextTime: stamp.contextTime, performanceTime: stamp.performanceTime, timeOrigin};
	}
	return {
		contextTime: context.currentTime - (context.baseLatency ?? 0) - (context.outputLatency ?? 0),
		performanceTime: performance.now(),
		timeOrigin,
	};
}

export function stemRoleForPlayback(role: StemRole, separateStems: boolean): StemRole | null {
	if (!PLAYABLE_ROLES.includes(role)) return null;
	// A single-mix song files its mix under some part name; it must play as backing and never duck.
	return separateStems ? role : 'backing';
}

interface RoleChannel {
	readonly gain: GainNode;
	buffers: Array<AudioBuffer>;
	level: number;
}

// Song playback on the shared voice AudioContext, so it follows the user's output device. One gain per stem role
// under a master volume; ducking is per part and the backing track never ducks.
export class BandAudio {
	private readonly master: GainNode;
	private readonly channels = new Map<StemRole, RoleChannel>();
	private sources: Array<AudioBufferSourceNode> = [];
	private disposed = false;

	constructor(
		readonly context: AudioContext,
		private readonly release: () => void = () => {},
	) {
		this.master = context.createGain();
		this.master.connect(context.destination);
	}

	static create(): BandAudio | null {
		const lease = acquireSharedVoiceAudioContext();
		if (!lease) return null;
		return new BandAudio(lease.context, lease.release);
	}

	// Where synthesized sounds (free play, metronome) connect so they share the volume.
	get output(): AudioNode {
		return this.master;
	}

	get durationMs(): number {
		let longest = 0;
		for (const channel of this.channels.values()) {
			for (const buffer of channel.buffers) longest = Math.max(longest, buffer.duration);
		}
		return longest * 1000;
	}

	async loadStems(stems: ReadonlyArray<AudioStem>, separateStems: boolean): Promise<void> {
		const decoded = await Promise.all(
			stems.map(async (stem) => {
				const role = stemRoleForPlayback(stem.role, separateStems);
				if (!role) return null;
				try {
					// decodeAudioData detaches its input; the package keeps its bytes.
					const buffer = await this.context.decodeAudioData(stem.data.slice().buffer);
					return {role, buffer};
				} catch (error) {
					logger.warn('Stem could not be decoded', {fileName: stem.fileName, error});
					return null;
				}
			}),
		);
		if (this.disposed) return;
		for (const entry of decoded) {
			if (entry) this.channel(entry.role).buffers.push(entry.buffer);
		}
	}

	readAnchor(): AudioClockAnchor {
		return readAudioAnchor(this.context);
	}

	// Lead the song start needs so the first frame is not scheduled into the past.
	minStartLeadSeconds(anchor: AudioClockAnchor): number {
		return Math.max(0, this.context.currentTime - anchor.contextTime) + MIN_START_LEAD_S;
	}

	start(schedule: SongStartSchedule): void {
		this.stopSources();
		for (const channel of this.channels.values()) {
			for (const buffer of channel.buffers) {
				if (schedule.offsetSeconds >= buffer.duration) continue;
				const source = this.context.createBufferSource();
				source.buffer = buffer;
				source.connect(channel.gain);
				source.start(schedule.contextTime, schedule.offsetSeconds);
				this.sources.push(source);
			}
		}
	}

	duck(part: BandPart, depth: DuckDepth): void {
		const channel = this.channels.get(part);
		if (!channel || channel.level === 0) return;
		const param = channel.gain.gain;
		applyGainPoints(param, duckEnvelope(this.context.currentTime, channel.level, param.value, depth));
	}

	// Silences a part outright; the vocals stem while someone sings live.
	setPartMuted(part: BandPart, muted: boolean): void {
		const channel = this.channel(part);
		channel.level = muted ? 0 : 1;
		const param = channel.gain.gain;
		param.cancelScheduledValues(this.context.currentTime);
		param.setValueAtTime(channel.level, this.context.currentTime);
	}

	setVolume(volume: number): void {
		const value = Math.min(1, Math.max(0, volume));
		this.master.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
	}

	playClick(contextTime: number, accent: boolean): void {
		const oscillator = this.context.createOscillator();
		const envelope = this.context.createGain();
		oscillator.frequency.value = accent ? 1_760 : 1_320;
		envelope.gain.setValueAtTime(0.6, contextTime);
		envelope.gain.exponentialRampToValueAtTime(0.001, contextTime + CLICK_LENGTH_S);
		oscillator.connect(envelope);
		envelope.connect(this.master);
		oscillator.start(contextTime);
		oscillator.stop(contextTime + CLICK_LENGTH_S);
	}

	stop(): void {
		this.stopSources();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopSources();
		for (const channel of this.channels.values()) channel.gain.disconnect();
		this.channels.clear();
		this.master.disconnect();
		this.release();
	}

	private channel(role: StemRole): RoleChannel {
		let channel = this.channels.get(role);
		if (!channel) {
			const gain = this.context.createGain();
			gain.connect(this.master);
			channel = {gain, buffers: [], level: 1};
			this.channels.set(role, channel);
		}
		return channel;
	}

	private stopSources(): void {
		for (const source of this.sources) {
			try {
				source.stop();
			} catch {
				// Already stopped or never started.
			}
			source.disconnect();
		}
		this.sources = [];
	}
}
