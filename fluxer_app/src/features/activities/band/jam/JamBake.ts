// SPDX-License-Identifier: AGPL-3.0-or-later

// Load-time buffer work for jam mode, ported from teknik.py and kutuphane.py: the seamless sustain loop, the
// pinch harmonic buffers, the feedback level match, the reverb impulse and the amp's waveshaper curves. Pure
// functions over Float32Arrays at the AudioContext's sample rate.

import {
	applyBiquads,
	bandpassCoefficients,
	butterworthHighpass,
	butterworthLowpass,
	gaussian,
	mulberry32,
	peakAbs,
	rms,
} from '@app/features/activities/band/jam/JamDsp';
import {stftMask} from '@app/features/activities/band/jam/JamFft';
import {
	FEEDBACK,
	harmonicSemitones,
	midiToHz,
	type PinchMethod,
	SUSTAIN_LOOP,
} from '@app/features/activities/band/jam/JamTechniques';

export interface SustainLoop {
	readonly buffer: Float32Array<ArrayBuffer>;
	readonly loopStart: number;
	readonly loopEnd: number;
	// Normalised correlation across the seam; the prototype measured 0.95-0.96.
	readonly seamCorrelation: number;
}

function correlation(signal: Float32Array, a: number, b: number, window: number): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < window; i++) {
		const x = signal[a + i];
		const y = signal[b + i];
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	return dot / (Math.sqrt(na * nb) + 1e-12);
}

// Centred moving RMS: the prototype's Savitzky-Golay smoothing of x² with polyorder 1 is a moving average.
function movingRms(signal: Float32Array, window: number): Float64Array {
	const half = Math.floor(window / 2);
	const prefix = new Float64Array(signal.length + 1);
	for (let i = 0; i < signal.length; i++) prefix[i + 1] = prefix[i] + signal[i] * signal[i];
	const out = new Float64Array(signal.length);
	for (let i = 0; i < signal.length; i++) {
		const from = Math.max(0, i - half);
		const to = Math.min(signal.length, i + half + 1);
		out[i] = Math.sqrt(Math.max((prefix[to] - prefix[from]) / (to - from), 1e-12));
	}
	return out;
}

// teknik.surdurme_tamponu: a ~0.3 s loop from 0.45 s, snapped to whole periods by autocorrelation, the decay
// flattened from the loop start on, and the loop's last 40 ms crossfaded with the 40 ms before the loop start.
export function bakeSustainLoop(signal: Float32Array, sampleRate: number, f0: number): SustainLoop {
	const period = sampleRate / f0;
	const loopStart = Math.round(SUSTAIN_LOOP.startS * sampleRate);
	const window = SUSTAIN_LOOP.correlationWindow;
	const periods = Math.max(1, Math.round((SUSTAIN_LOOP.lengthS * sampleRate) / period));
	const lastCandidate = Math.min(Math.floor((periods + 1) * period), signal.length - loopStart - window);
	let best = -2;
	let length = Math.round(periods * period);
	for (let candidate = Math.max(1, Math.floor((periods - 1) * period)); candidate <= lastCandidate; candidate++) {
		const c = correlation(signal, loopStart, loopStart + candidate, window);
		if (c > best) {
			best = c;
			length = candidate;
		}
	}
	const loopEnd = loopStart + length;
	const envelope = movingRms(signal, Math.floor(0.05 * sampleRate) | 1);
	const buffer = signal.slice(0, loopEnd);
	const reference = envelope[loopStart];
	for (let i = loopStart; i < loopEnd; i++) buffer[i] = (signal[i] * reference) / envelope[i];
	const fade = Math.round(SUSTAIN_LOOP.crossfadeS * sampleRate);
	for (let j = 0; j < fade; j++) {
		const w = fade > 1 ? j / (fade - 1) : 1;
		const i = loopEnd - fade + j;
		buffer[i] = buffer[i] * (1 - w) + signal[loopStart - fade + j] * w;
	}
	return {buffer, loopStart, loopEnd, seamCorrelation: best};
}

// Third-order Lagrange read of `signal` at fractional index `position`; samples before the start read as 0.
function lagrangeAt(signal: Float32Array, position: number): number {
	const base = Math.floor(position);
	const x = position - base;
	const ym1 = signal[base - 1] ?? 0;
	const y0 = signal[base] ?? 0;
	const y1 = signal[base + 1] ?? 0;
	const y2 = signal[base + 2] ?? 0;
	return (
		(-x * (x - 1) * (x - 2) * ym1) / 6 +
		((x + 1) * (x - 1) * (x - 2) * y0) / 2 -
		((x + 1) * x * (x - 2) * y1) / 2 +
		((x + 1) * x * (x - 1) * y2) / 6
	);
}

// Feedback comb y[n] = (1-g) x[n] + g y[n-D], D = 1/(k f0): keeps the multiples of the k-th harmonic, which is
// what touching the string at 1/k of its length does. D is fractional (Lagrange); the prototype ran at 4x instead.
export function nodeComb(signal: Float32Array, delaySamples: number, feedback: number): Float32Array<ArrayBuffer> {
	const out = new Float32Array(signal.length);
	for (let n = 0; n < signal.length; n++) {
		out[n] = (1 - feedback) * signal[n] + feedback * lagrangeAt(out, n - delaySamples);
	}
	return out;
}

export const PINCH_ATTACK_MS = 12;

// teknik._atak_ekle: the squeal starts with the real pick click. The pinch signal is normalised to its peak after
// 30 ms and the original note's first 12 ms (at half level) crossfade into it.
export function withPickAttack(
	pinch: Float32Array,
	original: Float32Array,
	sampleRate: number,
): Float32Array<ArrayBuffer> {
	const peak = peakAbs(pinch, Math.floor(0.03 * sampleRate)) + 1e-9;
	const out = new Float32Array(pinch.length);
	for (let i = 0; i < pinch.length; i++) out[i] = pinch[i] / peak;
	const n = Math.min(out.length, Math.round((PINCH_ATTACK_MS * sampleRate) / 1000));
	for (let i = 0; i < n; i++) {
		const w = n > 1 ? 1 - i / (n - 1) : 0;
		out[i] = (original[i] ?? 0) * 0.5 * w + out[i] * (1 - w);
	}
	return out;
}

export function pinchByComb(
	signal: Float32Array,
	sampleRate: number,
	f0: number,
	harmonic: number,
): Float32Array<ArrayBuffer> {
	const combed = nodeComb(signal, sampleRate / (harmonic * f0), 0.94);
	return withPickAttack(butterworthHighpass(combed, 0.7 * harmonic * f0, 4, sampleRate), signal, sampleRate);
}

export function resampleLinear(signal: Float32Array, ratio: number): Float32Array<ArrayBuffer> {
	const length = Math.max(0, Math.floor((signal.length - 1) / ratio));
	const out = new Float32Array(length);
	for (let i = 0; i < length; i++) {
		const position = i * ratio;
		const base = Math.floor(position);
		const frac = position - base;
		out[i] = signal[base] * (1 - frac) + (signal[base + 1] ?? 0) * frac;
	}
	return out;
}

// A: the real sample nearest the harmonic's pitch, shifted onto it, with nothing under it.
export function pinchByShift(
	original: Float32Array,
	nearTarget: {readonly signal: Float32Array; readonly midi: number},
	sampleRate: number,
	key: number,
	harmonic: number,
): Float32Array<ArrayBuffer> {
	const target = key + harmonicSemitones(harmonic);
	const shifted = resampleLinear(nearTarget.signal, 2 ** ((target - nearTarget.midi) / 12));
	return withPickAttack(butterworthHighpass(shifted, 0.75 * midiToHz(target), 4, sampleRate), original, sampleRate);
}

// C: STFT mask over the note's own partials; multiples of k +6 dB, everything else -35 dB.
export function pinchBySpectrum(
	signal: Float32Array,
	sampleRate: number,
	f0: number,
	harmonic: number,
): Float32Array<ArrayBuffer> {
	const size = 4096;
	const keep = 10 ** (6 / 20);
	const cut = 10 ** (-35 / 20);
	const binHz = sampleRate / size;
	const masked = stftMask(signal, size, 512, (bin) => {
		const hz = bin * binHz;
		for (let n = harmonic; n * f0 < 16_000; n += harmonic) {
			if (Math.abs(hz - n * f0) < 0.03 * n * f0 + 8) return keep;
		}
		return cut;
	});
	return withPickAttack(masked, signal, sampleRate);
}

export interface PinchSource {
	readonly signal: Float32Array;
	readonly midi: number;
}

export function bakePinch(
	method: PinchMethod,
	source: PinchSource,
	nearest: (midi: number) => PinchSource,
	sampleRate: number,
	harmonic: number,
): Float32Array<ArrayBuffer> {
	const f0 = midiToHz(source.midi);
	switch (method) {
		case 'comb':
			return pinchByComb(source.signal, sampleRate, f0, harmonic);
		case 'shift':
			return pinchByShift(
				source.signal,
				nearest(source.midi + harmonicSemitones(harmonic)),
				sampleRate,
				source.midi,
				harmonic,
			);
		case 'spectral':
			return pinchBySpectrum(source.signal, sampleRate, f0, harmonic);
	}
}

// fbNorm: full signal RMS over the loop / RMS of the two band-passes' output there, so the bloom lands at a level
// set by FEEDBACK.level whatever the harmonic's strength in this sample.
export function feedbackNorm(loop: SustainLoop, sampleRate: number, f0: number, harmonic = FEEDBACK.harmonic): number {
	const section = bandpassCoefficients(harmonic * f0, FEEDBACK.q, sampleRate);
	const filtered = applyBiquads(loop.buffer, [section, section]);
	const band = rms(filtered, loop.loopStart, loop.loopEnd);
	return band > 1e-9 ? rms(loop.buffer, loop.loopStart, loop.loopEnd) / band : 0;
}

// kutuphane.reverb_ir: stereo noise, 1.4 s RT60, low-passed at 5 kHz, 12 ms of silence first, unit energy per
// channel. Seeded so every client builds the same room.
export function reverbImpulse(sampleRate: number, seed = 3): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
	const length = Math.floor(1.8 * sampleRate);
	const silence = Math.floor(0.012 * sampleRate);
	const random = mulberry32(seed);
	const channels: Array<Float32Array<ArrayBuffer>> = [];
	for (let c = 0; c < 2; c++) {
		const noise = new Float32Array(length);
		for (let i = 0; i < length; i++) noise[i] = gaussian(random) * Math.exp((-6.9 * i) / sampleRate / 1.4);
		const filtered = butterworthLowpass(noise, 5000, 2, sampleRate);
		filtered.fill(0, 0, silence);
		const energy = Math.sqrt(filtered.reduce((sum, v) => sum + v * v, 0)) || 1;
		for (let i = 0; i < length; i++) filtered[i] /= energy;
		channels.push(filtered);
	}
	return [channels[0], channels[1]];
}

// WaveShaperNode clamps its input to [-1, 1], so the drive lives inside the curve. Odd length puts 0 on a point.
export const AMP_CURVE_POINTS = 16_385;

export function driveCurve(gain: number, bias: number): Float32Array<ArrayBuffer> {
	const curve = new Float32Array(AMP_CURVE_POINTS);
	const offset = Math.tanh(bias);
	for (let i = 0; i < AMP_CURVE_POINTS; i++) {
		const x = (2 * i) / (AMP_CURVE_POINTS - 1) - 1;
		curve[i] = Math.tanh(gain * x + bias) - offset;
	}
	return curve;
}

// The first stage swings to about -1.15 with the bias, past the shaper's input range; the second stage is fed
// through a 1/inputRange gain and the curve undoes it.
export const SECOND_STAGE_INPUT_RANGE = 1.25;

export function secondStageCurve(gain: number): Float32Array<ArrayBuffer> {
	const curve = new Float32Array(AMP_CURVE_POINTS);
	for (let i = 0; i < AMP_CURVE_POINTS; i++) {
		const x = ((2 * i) / (AMP_CURVE_POINTS - 1) - 1) * SECOND_STAGE_INPUT_RANGE;
		curve[i] = Math.tanh(gain * x);
	}
	return curve;
}
