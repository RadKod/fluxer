// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandPart} from '@app/features/activities/band/engine/ChartModel';
import type {AudioClockAnchor, SongStartSchedule} from '@app/features/activities/band/engine/SessionClock';
import type {AudioStem, StemRole} from '@app/features/activities/band/engine/SongPackage';
import type {DuckDepth} from '@app/features/activities/band/game/BandSettings';
import {WHAMMY, type WhammyModulation, whammyDelaySwingS} from '@app/features/activities/band/game/Whammy';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {acquireSharedVoiceAudioContext} from '@app/features/voice/engine/VoiceSharedAudioContext';

const logger = new Logger('BandAudio');

// Rock Band style: a missed note drops that part's stem and it stays down until the player hits again, so the whole
// band hears the part drop out and come back. Strong is near silence; light only thins it.
export const DUCK_SHAPES: Readonly<Record<DuckDepth, {readonly level: number}>> = {
	strong: {level: 0.05},
	light: {level: 0.3},
};
const DUCK_ATTACK_S = 0.03;
const RESTORE_S = 0.08;
const CLICK_LENGTH_S = 0.05;
// Audio cannot be scheduled into the past; this is the least lead given on top of the output latency.
const MIN_START_LEAD_S = 0.25;
// Rock Band style guide vocal: with someone singing live, the recorded vocals stay underneath at -12 dB, so the
// band keeps the melody and the singer has something to follow without being doubled.
export const GUIDE_VOCAL_GAIN = 0.25;
// The shared voice context soft-clips everything it plays above 0.8. A mastered song peaks near full scale, so at
// -3 dB it stays under that knee at any volume setting and the call's voices have room on top of it.
export const SONG_HEADROOM_GAIN = 0.7;

// During a freestyle solo the soloist's own recorded part drops to this, so the freestyle is not doubled by the record
// but the part's place in the mix is still felt.
export const FREESTYLE_STEM_LEVEL = 0.2;
const FREESTYLE_FADE_S = 0.12;

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

// Gain automation for a miss at `now`: a quick dip that holds until restoreEnvelope() runs on the next hit.
export function duckEnvelope(
	now: number,
	level: number,
	current: number,
	depth: DuckDepth = 'strong',
): ReadonlyArray<GainPoint> {
	return [
		{time: now, value: current, ramp: false},
		{time: now + DUCK_ATTACK_S, value: level * DUCK_SHAPES[depth].level, ramp: true},
	];
}

// Gain automation for the hit that ends a drop-out: back to the part's level over a short fade.
export function restoreEnvelope(now: number, level: number, current: number): ReadonlyArray<GainPoint> {
	return [
		{time: now, value: current, ramp: false},
		{time: now + RESTORE_S, value: level, ramp: true},
	];
}

export interface ContextSpan {
	readonly startTime: number;
	readonly endTime: number;
}

// Gain automation for a part's freestyle solo sections, in AudioContext time: down to FREESTYLE_STEM_LEVEL as each
// section starts and back up as it ends.
export function freestyleStemEnvelope(spans: ReadonlyArray<ContextSpan>): ReadonlyArray<GainPoint> {
	return spans.flatMap(({startTime, endTime}) => [
		{time: startTime, value: 1, ramp: false},
		{time: startTime + FREESTYLE_FADE_S, value: FREESTYLE_STEM_LEVEL, ramp: true},
		{time: endTime, value: FREESTYLE_STEM_LEVEL, ramp: false},
		{time: endTime + FREESTYLE_FADE_S, value: 1, ramp: true},
	]);
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

interface WhammyChain {
	readonly delay: DelayNode;
	readonly lfo: OscillatorNode;
	readonly swing: GainNode;
}

interface RoleChannel {
	readonly gain: GainNode;
	buffers: Array<AudioBuffer>;
	level: number;
	// The last node before the master; stages added later go between it and the master.
	tail: AudioNode;
	freestyleGain: GainNode | null;
	whammy: WhammyChain | null;
}

// Song playback on the shared voice AudioContext, so it follows the user's output device. One gain per stem role
// under a master volume; ducking is per part and the backing track never ducks.
export class BandAudio {
	private readonly master: GainNode;
	private readonly channels = new Map<StemRole, RoleChannel>();
	private readonly ducked = new Set<BandPart>();
	private sources: Array<AudioBufferSourceNode> = [];
	private disposed = false;

	constructor(
		readonly context: AudioContext,
		private readonly release: () => void = () => {},
	) {
		this.master = context.createGain();
		this.master.gain.value = SONG_HEADROOM_GAIN;
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
		this.ducked.add(part);
	}

	// The next hit after a miss brings the part back.
	restore(part: BandPart): void {
		const channel = this.channels.get(part);
		if (!channel || !this.ducked.delete(part) || channel.level === 0) return;
		const param = channel.gain.gain;
		applyGainPoints(param, restoreEnvelope(this.context.currentTime, channel.level, param.value));
	}

	// A part's resting level; misses duck from it and hits restore to it. Zero silences the part, misses included.
	setPartLevel(part: BandPart, level: number): void {
		const channel = this.channel(part);
		channel.level = Math.min(1, Math.max(0, level));
		const param = channel.gain.gain;
		param.cancelScheduledValues(this.context.currentTime);
		param.setValueAtTime(channel.level, this.context.currentTime);
	}

	// Ducks the part under each freestyle solo section; scheduled once, before the song starts, on the shared timing
	// every client computes alike. Separate from the miss ducking, which keeps working on top of it.
	scheduleFreestyleSolos(part: BandPart, spans: ReadonlyArray<ContextSpan>): void {
		const channel = this.channels.get(part);
		if (!channel || spans.length === 0) return;
		if (!channel.freestyleGain) {
			channel.freestyleGain = this.context.createGain();
			this.append(channel, channel.freestyleGain);
		}
		applyGainPoints(channel.freestyleGain.gain, freestyleStemEnvelope(spans));
	}

	// Puts the part's stem through the whammy's delay line; call before start() so the stem never jumps in time.
	// False when the song has no stem for the part.
	enableWhammy(part: BandPart): boolean {
		const channel = this.channels.get(part);
		if (!channel) return false;
		if (channel.whammy) return true;
		const delay = this.context.createDelay(WHAMMY.baseDelayS * 4);
		delay.delayTime.value = WHAMMY.baseDelayS;
		const lfo = this.context.createOscillator();
		lfo.frequency.value = WHAMMY.defaultRateHz;
		const swing = this.context.createGain();
		swing.gain.value = 0;
		lfo.connect(swing);
		swing.connect(delay.delayTime);
		lfo.start();
		this.append(channel, delay);
		channel.whammy = {delay, lfo, swing};
		return true;
	}

	setWhammy(part: BandPart, modulation: WhammyModulation): void {
		const chain = this.channels.get(part)?.whammy;
		if (!chain) return;
		const now = this.context.currentTime;
		const easing = modulation.depthCents > 0 ? WHAMMY.attackS : WHAMMY.releaseS;
		// setTargetAtTime gets within 5% of the target after three time constants.
		chain.swing.gain.setTargetAtTime(whammyDelaySwingS(modulation), now, easing / 3);
		chain.lfo.frequency.setTargetAtTime(modulation.rateHz, now, WHAMMY.attackS / 3);
	}

	setVolume(volume: number): void {
		const value = Math.min(1, Math.max(0, volume)) * SONG_HEADROOM_GAIN;
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
		for (const channel of this.channels.values()) {
			channel.gain.disconnect();
			channel.freestyleGain?.disconnect();
			if (channel.whammy) {
				channel.whammy.lfo.stop();
				channel.whammy.lfo.disconnect();
				channel.whammy.swing.disconnect();
				channel.whammy.delay.disconnect();
			}
		}
		this.channels.clear();
		this.master.disconnect();
		this.release();
	}

	private channel(role: StemRole): RoleChannel {
		let channel = this.channels.get(role);
		if (!channel) {
			const gain = this.context.createGain();
			gain.connect(this.master);
			channel = {gain, buffers: [], level: 1, tail: gain, freestyleGain: null, whammy: null};
			this.channels.set(role, channel);
		}
		return channel;
	}

	private append(channel: RoleChannel, node: AudioNode): void {
		channel.tail.disconnect(this.master);
		channel.tail.connect(node);
		node.connect(this.master);
		channel.tail = node;
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
