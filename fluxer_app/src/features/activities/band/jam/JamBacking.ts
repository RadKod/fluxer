// SPDX-License-Identifier: AGPL-3.0-or-later

// Backing loops for practising alone: drums and bass from step patterns, on the same samplers the players use, and
// a tempo click. Rock follows the band demo's groove (grup_dogaclama_110bpm); slow blues is a 12/8 shuffle over a
// 12-bar; punk is a fast eighth-note beat. The pattern side is pure; JamBacking schedules it ahead of the clock.

import type {JamMixer, JamPlayable} from '@app/features/activities/band/jam/JamInstruments';
import {
	foldIntoRange,
	homeRoot,
	JAM_DRUM_PIECES,
	type JamDrumPiece,
	type JamKey,
	type JamScale,
} from '@app/features/activities/band/jam/JamScales';

export type JamBackingStyle = 'rock' | 'slowBlues' | 'punk';
export const JAM_BACKING_STYLES: ReadonlyArray<JamBackingStyle> = ['rock', 'slowBlues', 'punk'];

// One bar of drums: per piece a string with one character per step. X loud, x medium, o soft, anything else rests.
type DrumBar = Partial<Record<JamDrumPiece, string>>;

export interface JamBackingPattern {
	readonly bpm: number;
	readonly stepsPerBeat: number;
	readonly beatsPerBar: number;
	// Bars cycle through the phrase; the last bar of a phrase plays the fill, the first opens with a crash.
	readonly drumBars: ReadonlyArray<DrumBar>;
	readonly fill: DrumBar;
	// One character per step: R/r root, O/o octave, F/f fifth, S/s sixth, B/b flat seventh (capital = accented).
	// Octave and seventh pops only sound when one chord fills the bar; under two chords they play the root.
	readonly bass: string;
	// Chord roots in semitones over the key, per bar of the phrase; two in a bar split it in half.
	readonly progression: {
		readonly minor: ReadonlyArray<ReadonlyArray<number>>;
		readonly major: ReadonlyArray<ReadonlyArray<number>>;
	};
}

const ROCK_GROOVE: DrumBar = {
	hh_kapali: 'X.x.X.x.X.x.X.x.',
	kick: 'X.........X.....',
	snare: '....X.......X...',
};

export const JAM_BACKING_PATTERNS: Readonly<Record<JamBackingStyle, JamBackingPattern>> = {
	rock: {
		bpm: 110,
		stepsPerBeat: 4,
		beatsPerBar: 4,
		drumBars: [
			ROCK_GROOVE,
			{...ROCK_GROOVE, hh_kapali: 'X.x.X.x.X.x.X...', hh_acik: '..............x.', kick: 'X.......X.X.....'},
		],
		fill: {
			hh_kapali: 'X.x.X.x.........',
			kick: 'X...............',
			snare: '....X...xx......',
			tom_ince: '..........xxx...',
			tom_kalin: '.............xxX',
		},
		bass: 'R.r.R.o.R.r.R.b.',
		progression: {minor: [[0], [0], [3, 5], [-2, -5]], major: [[0], [0], [5], [7]]},
	},
	slowBlues: {
		bpm: 66,
		stepsPerBeat: 3,
		beatsPerBar: 4,
		drumBars: [{hh_kapali: 'X.xX.xX.xX.x', kick: 'X....xX.....', snare: '...X.....X..'}],
		fill: {hh_kapali: 'X.xX.xX.x...', kick: 'X.....X.....', snare: '...X.....xxX'},
		bass: 'R.rF.fS.sF.f',
		progression: {
			minor: [[0], [5], [0], [0], [5], [5], [0], [0], [7], [5], [0], [7]],
			major: [[0], [5], [0], [0], [5], [5], [0], [0], [7], [5], [0], [7]],
		},
	},
	punk: {
		bpm: 180,
		stepsPerBeat: 2,
		beatsPerBar: 4,
		drumBars: [{hh_kapali: 'XxXxXxXx', kick: 'X...X.x.', snare: '..X...X.'}],
		fill: {hh_kapali: 'XxXx....', kick: 'X...X...', snare: '..X.xxXX'},
		bass: 'RrRrRrRr',
		progression: {minor: [[0], [-4], [3], [-2]], major: [[0], [7], [9], [5]]},
	},
};

const DRUM_VELOCITY: Readonly<Record<string, number>> = {X: 1, x: 0.75, o: 0.5};
const BASS_INTERVAL: Readonly<Record<string, number>> = {r: 0, o: 12, f: 7, s: 9, b: 10};
// Bass notes are played a little short of the next one, like the demo's 85%.
const BASS_LENGTH = 0.85;
// The demo's bass roots (E1 to D2); the pops an octave up stay within the samples.
const BASS_ROOT_RANGE = {low: 28, high: 39} as const;

export interface BackingNote {
	readonly instrument: 'drums' | 'bass';
	readonly note: number;
	readonly velocity: number;
	// Seconds; 0 for drums (one-shots).
	readonly lengthS: number;
}

export function stepSeconds(pattern: JamBackingPattern, bpm = pattern.bpm): number {
	return 60 / bpm / pattern.stepsPerBeat;
}

export function stepsPerBar(pattern: JamBackingPattern): number {
	return pattern.stepsPerBeat * pattern.beatsPerBar;
}

function progressionFor(pattern: JamBackingPattern, scale: JamScale): ReadonlyArray<ReadonlyArray<number>> {
	return scale === 'majorPentatonic' ? pattern.progression.major : pattern.progression.minor;
}

// Everything that starts on absolute step `step` (0 = first step of the loop).
export function backingNotesAt(
	pattern: JamBackingPattern,
	key: JamKey,
	scale: JamScale,
	step: number,
	bpm = pattern.bpm,
): ReadonlyArray<BackingNote> {
	const barSteps = stepsPerBar(pattern);
	const progression = progressionFor(pattern, scale);
	const bar = Math.floor(step / barSteps);
	const inBar = step - bar * barSteps;
	const phraseBar = bar % progression.length;
	const lastOfPhrase = phraseBar === progression.length - 1;
	const drums = lastOfPhrase ? pattern.fill : pattern.drumBars[phraseBar % pattern.drumBars.length];
	const notes: Array<BackingNote> = [];

	for (const piece of JAM_DRUM_PIECES) {
		const velocity = DRUM_VELOCITY[drums[piece]?.[inBar] ?? '.'];
		if (velocity === undefined) continue;
		if (piece === 'hh_kapali' && phraseBar === 0 && inBar === 0) continue;
		notes.push({instrument: 'drums', note: JAM_DRUM_PIECES.indexOf(piece), velocity, lengthS: 0});
	}
	if (phraseBar === 0 && inBar === 0) {
		notes.push({instrument: 'drums', note: JAM_DRUM_PIECES.indexOf('crash'), velocity: 0.95, lengthS: 0});
	}

	const symbol = pattern.bass[inBar] ?? '.';
	const baseInterval = BASS_INTERVAL[symbol.toLowerCase()];
	if (baseInterval !== undefined) {
		const chords = progression[phraseBar];
		const chord = chords[Math.min(chords.length - 1, Math.floor((inBar * chords.length) / barSteps))];
		const interval = chords.length > 1 && (baseInterval === 12 || baseInterval === 10) ? 0 : baseInterval;
		const root = foldIntoRange(homeRoot('bass', key) + chord, BASS_ROOT_RANGE);
		let next = inBar + 1;
		while (next < barSteps && BASS_INTERVAL[(pattern.bass[next] ?? '.').toLowerCase()] === undefined) next++;
		notes.push({
			instrument: 'bass',
			note: root + interval,
			velocity: symbol === symbol.toUpperCase() ? 0.92 : 0.8,
			lengthS: (next - inBar) * stepSeconds(pattern, bpm) * BASS_LENGTH,
		});
	}
	return notes;
}

// Deterministic jitter in [-1, 1] per step and voice, so the loop breathes the same way on every run.
export function humanNoise(step: number, salt: number): number {
	let h = Math.imul(step ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
	h ^= h >>> 13;
	h = Math.imul(h, 0x27d4eb2f);
	h ^= h >>> 16;
	return ((h >>> 0) / 4294967295) * 2 - 1;
}

const TIMING_JITTER_S = 0.005;
const VELOCITY_JITTER = 0.05;
const SCHEDULE_AHEAD_S = 0.12;
const TICK_MS = 25;
const CLICK_LENGTH_S = 0.03;
const CLICK_GAIN = 0.25;
// A synced loop is not moved for less drift than this; re-aligning would cut a step short or play it twice.
const SYNC_TOLERANCE_S = 0.015;
// The first step a synced loop schedules lies at least this far ahead.
const SYNC_LEAD_S = 0.03;

export interface JamBackingSettings {
	readonly style: JamBackingStyle;
	readonly key: JamKey;
	readonly scale: JamScale;
	readonly bpm: number;
	readonly drums: boolean;
	readonly bass: boolean;
	readonly click: boolean;
}

export class JamBacking {
	private readonly drums: JamPlayable;
	private readonly bass: JamPlayable;
	private readonly clickBus: GainNode;
	private timer: ReturnType<typeof setInterval> | null = null;
	private nextStep = 0;
	private nextStepTime = 0;
	// AudioContext time of step 0 while the loop follows a shared timeline (sync); null for a loop started here.
	private origin: number | null = null;

	constructor(
		private readonly mixer: JamMixer,
		private settings: JamBackingSettings,
	) {
		this.drums = mixer.create('drums');
		this.bass = mixer.create('bass');
		this.clickBus = new GainNode(mixer.context, {gain: CLICK_GAIN});
		this.clickBus.connect(mixer.input);
	}

	get running(): boolean {
		return this.timer !== null;
	}

	update(settings: Partial<JamBackingSettings>): void {
		this.settings = {...this.settings, ...settings};
	}

	start(): void {
		if (this.timer) return;
		this.origin = null;
		this.nextStep = 0;
		this.nextStepTime = this.mixer.context.currentTime + 0.1;
		this.timer = setInterval(() => this.schedule(), TICK_MS);
		this.schedule();
	}

	// Runs the loop on a shared timeline with step 0 at `origin` (AudioContext seconds): every client that maps the same
	// session time here plays the same step at the same moment, and a client joining later comes in mid-phrase. Called
	// again with the same timeline, it only corrects drift beyond SYNC_TOLERANCE_S.
	sync(origin: number): void {
		const stepS = stepSeconds(JAM_BACKING_PATTERNS[this.settings.style], this.settings.bpm);
		const drift = Math.abs(origin + this.nextStep * stepS - this.nextStepTime);
		const sameTimeline = this.origin !== null && this.timer !== null && drift < SYNC_TOLERANCE_S;
		this.origin = origin;
		if (!sameTimeline) this.alignToOrigin(origin);
		if (!this.timer) this.timer = setInterval(() => this.schedule(), TICK_MS);
		this.schedule();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.origin = null;
		const now = this.mixer.context.currentTime;
		this.drums.allNotesOff(now);
		this.bass.allNotesOff(now);
	}

	dispose(): void {
		this.stop();
		this.drums.dispose();
		this.bass.dispose();
		this.clickBus.disconnect();
	}

	private schedule(): void {
		const {context} = this.mixer;
		const pattern = JAM_BACKING_PATTERNS[this.settings.style];
		const stepS = stepSeconds(pattern, this.settings.bpm);
		// After a stall (a background tab) start again from now rather than rushing through the missed steps; a shared
		// loop picks up at the step the others are on.
		if (this.nextStepTime < context.currentTime) {
			if (this.origin === null) this.nextStepTime = context.currentTime + 0.05;
			else this.alignToOrigin(this.origin);
		}
		while (this.nextStepTime < context.currentTime + SCHEDULE_AHEAD_S) {
			this.playStep(pattern, this.nextStep, this.nextStepTime);
			this.nextStep++;
			this.nextStepTime += stepS;
		}
	}

	private alignToOrigin(origin: number): void {
		const stepS = stepSeconds(JAM_BACKING_PATTERNS[this.settings.style], this.settings.bpm);
		const earliest = this.mixer.context.currentTime + SYNC_LEAD_S;
		this.nextStep = Math.max(0, Math.ceil((earliest - origin) / stepS));
		this.nextStepTime = origin + this.nextStep * stepS;
	}

	private playStep(pattern: JamBackingPattern, step: number, time: number): void {
		const {key, scale, bpm, drums, bass, click} = this.settings;
		if (click && step % pattern.stepsPerBeat === 0) {
			this.click(time, step % stepsPerBar(pattern) === 0);
		}
		for (const [index, note] of backingNotesAt(pattern, key, scale, step, bpm).entries()) {
			if ((note.instrument === 'drums' && !drums) || (note.instrument === 'bass' && !bass)) continue;
			const at = Math.max(this.mixer.context.currentTime, time + humanNoise(step, index) * TIMING_JITTER_S);
			const velocity = Math.min(1, Math.max(0.3, note.velocity + humanNoise(step, index + 100) * VELOCITY_JITTER));
			const playable = note.instrument === 'drums' ? this.drums : this.bass;
			playable.noteOn(note.note, at, {velocity});
			if (note.lengthS > 0) playable.noteOff(note.note, at + note.lengthS);
		}
	}

	private click(time: number, downbeat: boolean): void {
		const {context} = this.mixer;
		const oscillator = new OscillatorNode(context, {type: 'square', frequency: downbeat ? 1500 : 1000});
		const envelope = new GainNode(context, {gain: 0});
		envelope.gain.setValueAtTime(downbeat ? 1 : 0.6, time);
		envelope.gain.exponentialRampToValueAtTime(0.001, time + CLICK_LENGTH_S);
		oscillator.connect(envelope);
		envelope.connect(this.clickBus);
		oscillator.onended = () => envelope.disconnect();
		oscillator.start(time);
		oscillator.stop(time + CLICK_LENGTH_S);
	}
}
