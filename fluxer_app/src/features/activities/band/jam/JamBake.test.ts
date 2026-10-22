// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	AMP_CURVE_POINTS,
	bakeSustainLoop,
	driveCurve,
	feedbackNorm,
	nodeComb,
	pinchByComb,
	pinchBySpectrum,
	reverbImpulse,
	SECOND_STAGE_INPUT_RANGE,
	secondStageCurve,
	withPickAttack,
} from '@app/features/activities/band/jam/JamBake';
import {
	applyBiquad,
	butterworthSectionQs,
	highpassCoefficients,
	leadingSilenceFrames,
	lowHighPassQToDecibels,
	peakingCoefficients,
	rms,
} from '@app/features/activities/band/jam/JamDsp';
import {stftMask} from '@app/features/activities/band/jam/JamFft';
import {describe, expect, it} from 'vitest';

const RATE = 48_000;

// A decaying plucked-string stand-in: 12 harmonics of f0, each a little weaker, the whole note dying away.
function pluck(f0: number, seconds: number, decayS = 1.2): Float32Array<ArrayBuffer> {
	const out = new Float32Array(Math.floor(seconds * RATE));
	for (let i = 0; i < out.length; i++) {
		const t = i / RATE;
		let v = 0;
		for (let n = 1; n <= 12; n++) v += Math.sin(2 * Math.PI * n * f0 * t) / n;
		out[i] = 0.5 * v * Math.exp(-t / decayS);
	}
	return out;
}

function toneLevel(signal: Float32Array, hz: number, from: number, to: number): number {
	let re = 0;
	let im = 0;
	for (let i = from; i < to; i++) {
		const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i - from)) / (to - from));
		re += signal[i] * w * Math.cos((2 * Math.PI * hz * i) / RATE);
		im += signal[i] * w * Math.sin((2 * Math.PI * hz * i) / RATE);
	}
	return Math.hypot(re, im);
}

const dB = (a: number, b: number) => 20 * Math.log10(a / b);

describe('JamDsp', () => {
	it('gives Butterworth section Qs and their BiquadFilterNode dB form', () => {
		expect(butterworthSectionQs(2)[0]).toBeCloseTo(Math.SQRT1_2, 6);
		const [low, high] = butterworthSectionQs(4);
		expect(low).toBeCloseTo(0.5412, 4);
		expect(high).toBeCloseTo(1.3066, 4);
		expect(lowHighPassQToDecibels(Math.SQRT1_2)).toBeCloseTo(-3.0103, 4);
	});

	it('filters like the cookbook says', () => {
		const tone = (hz: number) => Float32Array.from({length: RATE}, (_, i) => Math.sin((2 * Math.PI * hz * i) / RATE));
		const hp = highpassCoefficients(1000, Math.SQRT1_2, RATE);
		expect(rms(applyBiquad(tone(100), hp), RATE / 2)).toBeLessThan(0.02);
		expect(rms(applyBiquad(tone(10_000), hp), RATE / 2)).toBeCloseTo(Math.SQRT1_2, 2);
		const peak = peakingCoefficients(750, 0.8, 9, RATE);
		expect(dB(rms(applyBiquad(tone(750), peak), RATE / 2), Math.SQRT1_2)).toBeCloseTo(9, 1);
	});

	it('finds the onset 1 ms ahead, across channels', () => {
		const left = new Float32Array(1000);
		const right = new Float32Array(1000);
		right[500] = 1;
		left[700] = 0.5;
		expect(leadingSilenceFrames([left, right], RATE)).toBe(500 - 48);
		expect(leadingSilenceFrames([new Float32Array(10)], RATE)).toBe(0);
		const quiet = new Float32Array(1000);
		quiet[100] = 0.001;
		quiet[400] = 1;
		expect(leadingSilenceFrames([quiet], RATE)).toBe(400 - 48);
	});
});

describe('bakeSustainLoop', () => {
	it('loops on whole periods with a clean seam and a flat level', () => {
		const f0 = 220;
		const signal = pluck(f0, 2.4);
		const loop = bakeSustainLoop(signal, RATE, f0);
		const period = RATE / f0;
		const length = loop.loopEnd - loop.loopStart;
		expect(loop.loopStart).toBe(Math.round(0.45 * RATE));
		expect(Math.abs(length / period - Math.round(length / period))).toBeLessThan(0.05);
		expect(length / RATE).toBeGreaterThan(0.25);
		expect(length / RATE).toBeLessThan(0.35);
		expect(loop.seamCorrelation).toBeGreaterThan(0.99);
		expect(loop.buffer.length).toBe(loop.loopEnd);
		const first = rms(loop.buffer, loop.loopStart, loop.loopStart + 4800);
		const last = rms(loop.buffer, loop.loopEnd - 4800, loop.loopEnd);
		expect(Math.abs(dB(first, last))).toBeLessThan(0.5);
		// The loop's last sample is the one before the loop start, so wrapping around continues the waveform.
		expect(loop.buffer[loop.loopEnd - 1]).toBeCloseTo(signal[loop.loopStart - 1], 6);
	});
});

describe('pinch harmonic', () => {
	it('the comb at the string node keeps the k-th harmonic and kills the fundamental', () => {
		const f0 = 220;
		const signal = pluck(f0, 1.2);
		const from = Math.floor(0.05 * RATE);
		const to = Math.floor(0.8 * RATE);
		const plain = dB(toneLevel(signal, 3 * f0, from, to), toneLevel(signal, f0, from, to));
		const pinched = pinchByComb(signal, RATE, f0, 3);
		const ratio = dB(toneLevel(pinched, 3 * f0, from, to), toneLevel(pinched, f0, from, to));
		expect(plain).toBeLessThan(0);
		// The prototype measured +41 to +51 dB on the real samples.
		expect(ratio).toBeGreaterThan(35);
		expect(toneLevel(pinched, 6 * f0, from, to)).toBeGreaterThan(toneLevel(pinched, 4 * f0, from, to) * 10);
	});

	it('the comb follows a fractional delay', () => {
		const impulse = new Float32Array(400);
		impulse[0] = 1;
		const out = nodeComb(impulse, 100.5, 0.5);
		expect(out[0]).toBeCloseTo(0.5, 9);
		// The echo lands half way between samples 100 and 101.
		expect(out[100]).toBeCloseTo(out[101], 9);
		expect(out[100] + out[101]).toBeGreaterThan(0.2);
		expect(out[99]).toBeLessThan(0.02);
	});

	it('starts with the real pick click', () => {
		const original = Float32Array.from({length: 2000}, (_, i) => (i < 10 ? 1 : 0));
		const pinch = Float32Array.from({length: 2000}, () => 0.25);
		const out = withPickAttack(pinch, original, RATE);
		expect(out[0]).toBeCloseTo(0.5, 9);
		expect(out[1500]).toBeCloseTo(1, 9);
	});

	it('the spectral mask brings the harmonic up too', () => {
		const f0 = 220;
		const signal = pluck(f0, 1);
		const out = pinchBySpectrum(signal, RATE, f0, 3);
		const from = Math.floor(0.1 * RATE);
		const to = Math.floor(0.7 * RATE);
		expect(dB(toneLevel(out, 3 * f0, from, to), toneLevel(out, f0, from, to))).toBeGreaterThan(20);
	});

	it('an all-pass STFT mask gives the signal back', () => {
		const signal = pluck(330, 0.5);
		const out = stftMask(signal, 4096, 512, () => 1);
		let error = 0;
		for (let i = 0; i < signal.length; i++) error = Math.max(error, Math.abs(out[i] - signal[i]));
		expect(error).toBeLessThan(1e-4);
	});
});

describe('feedback, reverb and amp curves', () => {
	it('matches the band-passed harmonic to the note level', () => {
		const f0 = 220;
		const loop = bakeSustainLoop(pluck(f0, 2.4), RATE, f0);
		const norm = feedbackNorm(loop, RATE, f0, 2);
		// The 2nd harmonic is half the fundamental and about a third of the whole signal's RMS.
		expect(norm).toBeGreaterThan(2);
		expect(norm).toBeLessThan(4);
	});

	it('builds the same unit-energy room every time', () => {
		const [left, right] = reverbImpulse(RATE);
		const [again] = reverbImpulse(RATE);
		expect(left.length).toBe(Math.floor(1.8 * RATE));
		expect(left).toEqual(again);
		expect(left.slice(0, Math.floor(0.012 * RATE)).every((v) => v === 0)).toBe(true);
		expect(rms(left) * Math.sqrt(left.length)).toBeCloseTo(1, 6);
		expect(left).not.toEqual(right);
	});

	it('shapes like kutuphane.amfi', () => {
		const drive = driveCurve(50, 0.15);
		const middle = (AMP_CURVE_POINTS - 1) / 2;
		expect(drive).toHaveLength(AMP_CURVE_POINTS);
		expect(drive[middle]).toBeCloseTo(0, 12);
		expect(drive[AMP_CURVE_POINTS - 1]).toBeCloseTo(1 - Math.tanh(0.15), 5);
		expect(drive[0]).toBeCloseTo(-1 - Math.tanh(0.15), 5);
		const second = secondStageCurve(2.5);
		// Input x arrives as x / 1.25, so the curve's end is tanh(2.5 * 1.25).
		expect(second[AMP_CURVE_POINTS - 1]).toBeCloseTo(Math.tanh(2.5 * SECOND_STAGE_INPUT_RANGE), 6);
	});
});
