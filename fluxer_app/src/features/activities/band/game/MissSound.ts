// SPDX-License-Identifier: AGPL-3.0-or-later

import type {InstrumentPart} from '@app/features/activities/band/engine/ChartModel';

// The sound of my own miss, quiet and short so it reads as a mistake rather than a note: a muted-string clunk for
// fret parts, a dull thud for drums. Synthesized, like the finale voices.
const LEVEL = 0.22;
const NOISE_SECONDS = 0.1;
// A chord mashed wrong gives several misses within a few frames; one sound is enough.
export const MISS_SOUND_GAP_S = 0.08;

const BODY_HZ: Readonly<Record<Exclude<InstrumentPart, 'drums'>, number>> = {
	guitar: 110,
	rhythm: 98,
	bass: 55,
	keys: 131,
};

export class MissSound {
	private noise: AudioBuffer | null = null;
	private lastAt = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly context: AudioContext,
		private readonly output: AudioNode,
	) {}

	play(part: InstrumentPart): void {
		const when = this.context.currentTime;
		if (when - this.lastAt < MISS_SOUND_GAP_S) return;
		this.lastAt = when;
		if (part === 'drums') {
			this.body('sine', 120, 50, 0.14, when, LEVEL * 1.4);
			this.scrape('lowpass', 500, 0.06, when, LEVEL * 0.6);
			return;
		}
		const hz = BODY_HZ[part];
		this.body('triangle', hz * 1.06, hz, 0.07, when, LEVEL);
		this.scrape('bandpass', part === 'bass' ? 500 : 1_100, 0.045, when, LEVEL);
	}

	private body(type: OscillatorType, fromHz: number, toHz: number, seconds: number, when: number, level: number): void {
		const {context} = this;
		const oscillator = context.createOscillator();
		oscillator.type = type;
		oscillator.frequency.setValueAtTime(fromHz, when);
		oscillator.frequency.exponentialRampToValueAtTime(toHz, when + seconds);
		const envelope = context.createGain();
		envelope.gain.setValueAtTime(level, when);
		envelope.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
		oscillator.connect(envelope).connect(this.output);
		oscillator.start(when);
		oscillator.stop(when + seconds + 0.02);
	}

	private scrape(type: BiquadFilterType, hz: number, seconds: number, when: number, level: number): void {
		const {context} = this;
		const source = context.createBufferSource();
		source.buffer = this.noiseBuffer();
		const filter = context.createBiquadFilter();
		filter.type = type;
		filter.frequency.value = hz;
		filter.Q.value = 1.2;
		const envelope = context.createGain();
		envelope.gain.setValueAtTime(level, when);
		envelope.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
		source.connect(filter).connect(envelope).connect(this.output);
		source.start(when);
		source.stop(when + seconds);
	}

	private noiseBuffer(): AudioBuffer {
		if (this.noise) return this.noise;
		const length = Math.floor(this.context.sampleRate * NOISE_SECONDS);
		const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
		const samples = buffer.getChannelData(0);
		for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
		this.noise = buffer;
		return buffer;
	}
}
