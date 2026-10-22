// SPDX-License-Identifier: AGPL-3.0-or-later

// Offline DSP on Float32Arrays for jam mode's load-time work (sample trimming, sustain loops, pinch buffers, the
// reverb impulse). Biquads follow the Audio EQ Cookbook, the same formulas BiquadFilterNode uses, so a filter baked
// here matches the live one with the same settings.

export interface BiquadCoefficients {
	readonly b0: number;
	readonly b1: number;
	readonly b2: number;
	readonly a1: number;
	readonly a2: number;
}

// Q of each second-order section of a Butterworth filter of the given even order (2 -> 0.707, 4 -> 0.541, 1.307).
export function butterworthSectionQs(order: number): ReadonlyArray<number> {
	const qs: Array<number> = [];
	for (let k = 0; k < order / 2; k++) {
		qs.push(1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order))));
	}
	return qs.sort((a, b) => a - b);
}

// BiquadFilterNode reads Q of its lowpass and highpass types in dB; the other types take it as a plain ratio.
export function lowHighPassQToDecibels(q: number): number {
	return 20 * Math.log10(q);
}

function normalise(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoefficients {
	return {b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0};
}

function omega(frequency: number, sampleRate: number): {cos: number; sin: number} {
	const w = (2 * Math.PI * frequency) / sampleRate;
	return {cos: Math.cos(w), sin: Math.sin(w)};
}

export function lowpassCoefficients(frequency: number, q: number, sampleRate: number): BiquadCoefficients {
	const {cos, sin} = omega(frequency, sampleRate);
	const alpha = sin / (2 * q);
	return normalise((1 - cos) / 2, 1 - cos, (1 - cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

export function highpassCoefficients(frequency: number, q: number, sampleRate: number): BiquadCoefficients {
	const {cos, sin} = omega(frequency, sampleRate);
	const alpha = sin / (2 * q);
	return normalise((1 + cos) / 2, -(1 + cos), (1 + cos) / 2, 1 + alpha, -2 * cos, 1 - alpha);
}

// Constant 0 dB peak gain, like BiquadFilterNode's bandpass.
export function bandpassCoefficients(frequency: number, q: number, sampleRate: number): BiquadCoefficients {
	const {cos, sin} = omega(frequency, sampleRate);
	const alpha = sin / (2 * q);
	return normalise(alpha, 0, -alpha, 1 + alpha, -2 * cos, 1 - alpha);
}

export function peakingCoefficients(
	frequency: number,
	q: number,
	gainDb: number,
	sampleRate: number,
): BiquadCoefficients {
	const {cos, sin} = omega(frequency, sampleRate);
	const a = 10 ** (gainDb / 40);
	const alpha = sin / (2 * q);
	return normalise(1 + alpha * a, -2 * cos, 1 - alpha * a, 1 + alpha / a, -2 * cos, 1 - alpha / a);
}

// First-order Butterworth high-pass by the bilinear transform, as [feedforward, feedback] for an IIRFilterNode.
export function firstOrderHighpass(
	frequency: number,
	sampleRate: number,
): {
	readonly feedforward: [number, number];
	readonly feedback: [number, number];
} {
	const k = Math.tan((Math.PI * frequency) / sampleRate);
	const norm = 1 / (1 + k);
	return {feedforward: [norm, -norm], feedback: [1, (k - 1) * norm]};
}

// Transposed direct form II, double-precision state; returns a new array.
export function applyBiquad(input: Float32Array, c: BiquadCoefficients): Float32Array<ArrayBuffer> {
	const output = new Float32Array(input.length);
	let z1 = 0;
	let z2 = 0;
	for (let i = 0; i < input.length; i++) {
		const x = input[i];
		const y = c.b0 * x + z1;
		z1 = c.b1 * x - c.a1 * y + z2;
		z2 = c.b2 * x - c.a2 * y;
		output[i] = y;
	}
	return output;
}

export function applyBiquads(
	input: Float32Array,
	sections: ReadonlyArray<BiquadCoefficients>,
): Float32Array<ArrayBuffer> {
	let signal = new Float32Array(input);
	for (const section of sections) signal = applyBiquad(signal, section);
	return signal;
}

export function butterworthHighpass(
	input: Float32Array,
	frequency: number,
	order: number,
	sampleRate: number,
): Float32Array<ArrayBuffer> {
	return applyBiquads(
		input,
		butterworthSectionQs(order).map((q) => highpassCoefficients(frequency, q, sampleRate)),
	);
}

export function butterworthLowpass(
	input: Float32Array,
	frequency: number,
	order: number,
	sampleRate: number,
): Float32Array<ArrayBuffer> {
	return applyBiquads(
		input,
		butterworthSectionQs(order).map((q) => lowpassCoefficients(frequency, q, sampleRate)),
	);
}

export function peakAbs(signal: Float32Array, from = 0, to = signal.length): number {
	let peak = 0;
	for (let i = from; i < to; i++) {
		const v = Math.abs(signal[i]);
		if (v > peak) peak = v;
	}
	return peak;
}

export function rms(signal: Float32Array, from = 0, to = signal.length): number {
	if (to <= from) return 0;
	let sum = 0;
	for (let i = from; i < to; i++) sum += signal[i] * signal[i];
	return Math.sqrt(sum / (to - from));
}

// First frame to keep: 1 ms before the first sample above `thresholdDb` of the peak (over all channels). Encoders
// pad the start (MP3 priming, AAC, browsers that ignore Opus pre-skip); cutting to the onset removes that delay
// whatever the format, since the source files were trimmed the same way.
export function leadingSilenceFrames(
	channels: ReadonlyArray<Float32Array>,
	sampleRate: number,
	thresholdDb = -45,
	preRollMs = 1,
): number {
	const length = channels[0]?.length ?? 0;
	let peak = 0;
	for (const channel of channels) peak = Math.max(peak, peakAbs(channel));
	if (peak === 0) return 0;
	const threshold = peak * 10 ** (thresholdDb / 20);
	for (let i = 0; i < length; i++) {
		for (const channel of channels) {
			if (Math.abs(channel[i]) > threshold) {
				return Math.max(0, i - Math.floor((sampleRate * preRollMs) / 1000));
			}
		}
	}
	return 0;
}

// Small seeded PRNG so baked noise (the reverb tail) is the same on every client and in tests.
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function gaussian(random: () => number): number {
	const u = Math.max(random(), 1e-12);
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
