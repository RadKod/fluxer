// SPDX-License-Identifier: AGPL-3.0-or-later

import {DrumLane, type InstrumentPart} from '@app/features/activities/band/engine/ChartModel';

// Sample-free voices for Big Rock Ending free play: a plucked, saturated note for frets and keys, synthesized kit
// pieces for drums. Song keys are not in the chart metadata, so frets play an E minor pentatonic, the safest rock key.
const E2_HZ = 82.41;
const PENTATONIC_SEMITONES = [0, 3, 5, 7, 10, 12];
const OCTAVE_BY_PART: Readonly<Record<Exclude<InstrumentPart, 'drums'>, number>> = {
	guitar: 2,
	rhythm: 1,
	bass: 0,
	keys: 2,
};
const NOISE_SECONDS = 0.5;

export function fretFrequency(part: Exclude<InstrumentPart, 'drums'>, lane: number): number {
	const semitones = PENTATONIC_SEMITONES[Math.min(Math.max(lane, 0), PENTATONIC_SEMITONES.length - 1)];
	return E2_HZ * 2 ** (OCTAVE_BY_PART[part] + semitones / 12);
}

export class FinaleSynth {
	private noise: AudioBuffer | null = null;

	constructor(
		private readonly context: AudioContext,
		private readonly output: AudioNode,
	) {}

	// Remote players' notes play a little softer than mine.
	play(part: InstrumentPart, lane: number, mine: boolean): void {
		const level = mine ? 0.5 : 0.28;
		const when = this.context.currentTime;
		if (part === 'drums') this.drum(lane, when, level);
		else this.pluck(fretFrequency(part, lane), when, level, part === 'bass');
	}

	private pluck(frequency: number, when: number, level: number, dark: boolean): void {
		const {context} = this;
		const oscillator = context.createOscillator();
		oscillator.type = 'sawtooth';
		oscillator.frequency.value = frequency;
		const filter = context.createBiquadFilter();
		filter.type = 'lowpass';
		filter.Q.value = 6;
		filter.frequency.setValueAtTime(dark ? 1_800 : 4_200, when);
		filter.frequency.exponentialRampToValueAtTime(dark ? 260 : 700, when + 0.5);
		const envelope = context.createGain();
		envelope.gain.setValueAtTime(0.0001, when);
		envelope.gain.exponentialRampToValueAtTime(level, when + 0.005);
		envelope.gain.exponentialRampToValueAtTime(0.0001, when + 0.9);
		oscillator.connect(filter).connect(envelope).connect(this.output);
		oscillator.start(when);
		oscillator.stop(when + 0.95);
	}

	private drum(lane: number, when: number, level: number): void {
		if (lane === DrumLane.Kick) {
			this.tone(150, 45, 0.35, when, level * 1.4);
			return;
		}
		if (lane === DrumLane.Red) {
			this.tone(190, 160, 0.12, when, level * 0.6);
			this.hiss(when, 0.18, 1_800, level);
			return;
		}
		// Yellow and green ring like cymbals; blue is a tom.
		if (lane === DrumLane.Blue) this.tone(120, 80, 0.3, when, level);
		else this.hiss(when, lane === DrumLane.Green ? 0.6 : 0.25, 6_000, level * 0.7);
	}

	private tone(from: number, to: number, seconds: number, when: number, level: number): void {
		const {context} = this;
		const oscillator = context.createOscillator();
		oscillator.frequency.setValueAtTime(from, when);
		oscillator.frequency.exponentialRampToValueAtTime(to, when + seconds);
		const envelope = context.createGain();
		envelope.gain.setValueAtTime(level, when);
		envelope.gain.exponentialRampToValueAtTime(0.0001, when + seconds);
		oscillator.connect(envelope).connect(this.output);
		oscillator.start(when);
		oscillator.stop(when + seconds + 0.02);
	}

	private hiss(when: number, seconds: number, highpassHz: number, level: number): void {
		const {context} = this;
		const source = context.createBufferSource();
		source.buffer = this.noiseBuffer();
		const filter = context.createBiquadFilter();
		filter.type = 'highpass';
		filter.frequency.value = highpassHz;
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
