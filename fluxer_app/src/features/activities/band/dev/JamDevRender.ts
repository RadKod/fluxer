// SPDX-License-Identifier: AGPL-3.0-or-later

// Offline render of the technique demos (teknik.py's bend, pinch and feedback sequences) through the real engine,
// with the numbers the prototype printed, so the port can be checked against teknik_*.wav without ears:
//   window.jamDev.renderTechniques() in the harness page.
// The render can also be saved as a WAV to A/B against the approved demos.

import {loadJamSamples} from '@app/features/activities/band/jam/JamAssets';
import {JamMixer, type JamPlayable} from '@app/features/activities/band/jam/JamInstruments';
import {type BendSemitones, midiToHz} from '@app/features/activities/band/jam/JamTechniques';

const SAMPLE_RATE = 44_100;

interface DemoNote {
	readonly at: number;
	readonly midi: number;
	readonly holdS: number;
	readonly pinchHarmonic?: number;
	readonly bend?: {readonly semitones: BendSemitones; readonly onS: number; readonly offS?: number};
}

// Same plans and timings as teknik.py; the pinch section uses approach B's notes (A3 k=3, D4 k=3, C4 k=5).
const BEND_NOTES: ReadonlyArray<DemoNote> = [
	{at: 0.5, midi: 62, holdS: 2, bend: {semitones: 1, onS: 0.35, offS: 1.3}},
	{at: 3.5, midi: 62, holdS: 2.6, bend: {semitones: 2, onS: 0.3, offS: 1.9}},
	{at: 7, midi: 69, holdS: 3.6, bend: {semitones: 3, onS: 0.3, offS: 3}},
	{at: 11.5, midi: 74, holdS: 4.2, bend: {semitones: 2, onS: 0.25, offS: 3.4}},
	{at: 16.5, midi: 67, holdS: 3.5, bend: {semitones: 2, onS: 0.2}},
];
const PINCH_START = 21;
const PINCH_NOTES: ReadonlyArray<DemoNote> = [
	{at: PINCH_START, midi: 57, holdS: 0.9},
	{at: PINCH_START + 1.1, midi: 57, holdS: 2.2, pinchHarmonic: 3},
	{at: PINCH_START + 3.6, midi: 62, holdS: 1.8, pinchHarmonic: 3},
	{at: PINCH_START + 5.6, midi: 60, holdS: 2, pinchHarmonic: 5, bend: {semitones: 2, onS: 0.15}},
];
const FEEDBACK_START = 30;
const FEEDBACK_NOTES: ReadonlyArray<DemoNote> = [
	{at: FEEDBACK_START, midi: 57, holdS: 5.6},
	{at: FEEDBACK_START + 7, midi: 64, holdS: 5.6},
	{at: FEEDBACK_START + 14, midi: 62, holdS: 5.6, bend: {semitones: 2, onS: 0.25}},
];
const LENGTH_S = FEEDBACK_START + 21;

function schedule(guitar: JamPlayable, notes: ReadonlyArray<DemoNote>): void {
	for (const note of notes) {
		guitar.noteOn(note.midi, note.at, {velocity: 0.92, pinchHarmonic: note.pinchHarmonic ?? 0});
		if (note.bend) {
			guitar.bendOn(note.bend.semitones, note.at + note.bend.onS);
			if (note.bend.offS !== undefined) guitar.bendOff(note.at + note.bend.offS);
		}
		guitar.noteOff(note.midi, note.at + note.holdS);
	}
}

// Level of one frequency over a window (Goertzel with a Hann window), in dB.
function toneDb(signal: Float32Array, fromS: number, toS: number, hz: number): number {
	const from = Math.floor(fromS * SAMPLE_RATE);
	const n = Math.floor((toS - fromS) * SAMPLE_RATE);
	const w = (2 * Math.PI * hz) / SAMPLE_RATE;
	const coeff = 2 * Math.cos(w);
	let s1 = 0;
	let s2 = 0;
	for (let i = 0; i < n; i++) {
		const x = (signal[from + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
		const s0 = x + coeff * s1 - s2;
		s2 = s1;
		s1 = s0;
	}
	const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
	return 10 * Math.log10(power + 1e-20);
}

// Fundamental by normalised autocorrelation, searched around the expected pitch; cents from that pitch.
function pitchCents(signal: Float32Array, atS: number, expectedHz: number): number {
	const window = Math.floor(0.05 * SAMPLE_RATE);
	const from = Math.floor(atS * SAMPLE_RATE);
	const minLag = Math.floor(SAMPLE_RATE / (expectedHz * 2 ** (500 / 1200)));
	const maxLag = Math.ceil(SAMPLE_RATE / (expectedHz * 2 ** (-300 / 1200)));
	let bestLag = minLag;
	let best = -Infinity;
	const scores: Array<number> = [];
	for (let lag = minLag; lag <= maxLag; lag++) {
		let dot = 0;
		let na = 0;
		let nb = 0;
		for (let i = 0; i < window; i++) {
			const a = signal[from + i] ?? 0;
			const b = signal[from + i + lag] ?? 0;
			dot += a * b;
			na += a * a;
			nb += b * b;
		}
		const score = dot / (Math.sqrt(na * nb) + 1e-12);
		scores.push(score);
		if (score > best) {
			best = score;
			bestLag = lag;
		}
	}
	// Parabolic interpolation around the best lag.
	const i = bestLag - minLag;
	let shift = 0;
	if (i > 0 && i < scores.length - 1) {
		const curvature = scores[i - 1] - 2 * scores[i] + scores[i + 1];
		if (curvature !== 0) shift = (0.5 * (scores[i - 1] - scores[i + 1])) / curvature;
	}
	return 1200 * Math.log2(SAMPLE_RATE / (bestLag + shift) / expectedHz);
}

export interface JamTechniqueReport {
	readonly format: string;
	readonly peak: number;
	readonly rms: number;
	readonly bends: ReadonlyArray<{
		readonly midi: number;
		readonly target: number;
		readonly peakCents: number;
		readonly heldCents: number;
	}>;
	readonly pinch: ReadonlyArray<{
		readonly midi: number;
		readonly harmonic: number;
		readonly harmonicOverFundamentalDb: number;
	}>;
	readonly plainHarmonicOverFundamentalDb: number;
	readonly feedback: ReadonlyArray<{readonly midi: number; readonly beforeDb: number; readonly afterDb: number}>;
}

export async function renderJamTechniques(baseUrl: string): Promise<{buffer: AudioBuffer; report: JamTechniqueReport}> {
	const context = new OfflineAudioContext(2, Math.ceil(LENGTH_S * SAMPLE_RATE), SAMPLE_RATE);
	const bank = await loadJamSamples(context, {baseUrl});
	const mixer = new JamMixer(context, bank, context.destination);
	const guitar = mixer.create('guitar');
	schedule(guitar, [...BEND_NOTES, ...PINCH_NOTES, ...FEEDBACK_NOTES]);
	const buffer = await context.startRendering();
	const left = buffer.getChannelData(0);

	let peak = 0;
	let sum = 0;
	for (const v of left) {
		peak = Math.max(peak, Math.abs(v));
		sum += v * v;
	}
	const bends = BEND_NOTES.map((note) => {
		const bend = note.bend ?? {semitones: 2 as const, onS: 0};
		const start = note.at + bend.onS;
		let peakCents = -Infinity;
		for (let t = start + 0.05; t < start + 0.3; t += 0.01) {
			peakCents = Math.max(peakCents, pitchCents(left, t, midiToHz(note.midi)));
		}
		return {
			midi: note.midi,
			target: bend.semitones * 100,
			peakCents: Math.round(peakCents),
			// Before the bend vibrato comes in.
			heldCents: Math.round(pitchCents(left, start + 0.3, midiToHz(note.midi))),
		};
	});
	const pinch = PINCH_NOTES.filter((note) => note.pinchHarmonic).map((note) => {
		const f0 = midiToHz(note.midi);
		const k = note.pinchHarmonic ?? 3;
		return {
			midi: note.midi,
			harmonic: k,
			harmonicOverFundamentalDb:
				Math.round(
					10 *
						(toneDb(left, note.at + 0.05, note.at + 0.14, k * f0) - toneDb(left, note.at + 0.05, note.at + 0.14, f0)),
				) / 10,
		};
	});
	const plain = PINCH_NOTES[0];
	const plainF0 = midiToHz(plain.midi);
	const feedback = FEEDBACK_NOTES.map((note) => {
		const f0 = midiToHz(note.midi + (note.bend ? note.bend.semitones : 0));
		const ratio = (from: number, to: number) => toneDb(left, from, to, 2 * f0) - toneDb(left, from, to, f0);
		return {
			midi: note.midi,
			beforeDb: Math.round(10 * ratio(note.at + 0.8, note.at + 1.6)) / 10,
			afterDb: Math.round(10 * ratio(note.at + 3.4, note.at + 5.4)) / 10,
		};
	});
	return {
		buffer,
		report: {
			format: bank.format,
			peak,
			rms: Math.sqrt(sum / left.length),
			bends,
			pinch,
			plainHarmonicOverFundamentalDb:
				Math.round(
					10 *
						(toneDb(left, plain.at + 0.05, plain.at + 0.8, 3 * plainF0) -
							toneDb(left, plain.at + 0.05, plain.at + 0.8, plainF0)),
				) / 10,
			feedback,
		},
	};
}

// 16-bit PCM WAV of a rendered buffer.
export function encodeWav(buffer: AudioBuffer): Blob {
	const channels = buffer.numberOfChannels;
	const frames = buffer.length;
	const view = new DataView(new ArrayBuffer(44 + frames * channels * 2));
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
	};
	text(0, 'RIFF');
	view.setUint32(4, 36 + frames * channels * 2, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, buffer.sampleRate, true);
	view.setUint32(28, buffer.sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, frames * channels * 2, true);
	const data = Array.from({length: channels}, (_, c) => buffer.getChannelData(c));
	let offset = 44;
	for (let i = 0; i < frames; i++) {
		for (let c = 0; c < channels; c++) {
			view.setInt16(offset, Math.max(-1, Math.min(1, data[c][i])) * 0x7fff, true);
			offset += 2;
		}
	}
	return new Blob([view.buffer], {type: 'audio/wav'});
}
