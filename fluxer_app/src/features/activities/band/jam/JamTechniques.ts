// SPDX-License-Identifier: AGPL-3.0-or-later

// Lead guitar technique parameters and the pure curves behind them, ported from the approved prototype
// (sanalyer-sarki-arsiv/dogaclama/araclar/teknik.py, notes in dogaclama/teknikler.md).
//
// Only note on (normal or pinch), note off, bend on and bend off cross the network. Vibrato and feedback follow
// from how long a note or bend is held, so every client rebuilds the same curves from the same event times.

export type BendSemitones = 1 | 2 | 3;

export interface BendShape {
	readonly cents: number;
	// 10-90% rise time of the step response.
	readonly riseS: number;
}

// Rise times from the bend demo: half step 90 ms, whole step 110 ms, step and a half 150 ms.
export const BEND_SHAPES: Readonly<Record<BendSemitones, BendShape>> = {
	1: {cents: 100, riseS: 0.09},
	2: {cents: 200, riseS: 0.11},
	3: {cents: 300, riseS: 0.15},
};
// Damping 0.6 overshoots about 9% (a whole step passes ~18 cents over and settles), like a real push.
export const BEND_ZETA = 0.6;
export const BEND_RELEASE_RISE_S = 0.15;
export const BEND_RELEASE_ZETA = 0.9;
// Pitch automation is laid down as short linear ramps rather than setValueCurveAtTime, so a release in the middle
// of a bend can cancel cleanly in every browser (Firefox has no cancelAndHoldAtTime).
export const PITCH_STEP_S = 0.005;

export interface VibratoShape {
	readonly delayS: number;
	readonly depthCents: number;
	readonly rateHz: number;
	readonly fadeInS: number;
	// Players vibrate a held bend by easing off it, so the pitch centre drops a little.
	readonly centreCents: number;
}

// A note held this long gets a light vibrato.
export const HOLD_VIBRATO: VibratoShape = {delayS: 0.6, depthCents: 20, rateHz: 5.5, fadeInS: 0.25, centreCents: 0};
// A bend held this long (from bend on) gets the full one.
export const BEND_VIBRATO: VibratoShape = {delayS: 0.35, depthCents: 35, rateHz: 5.6, fadeInS: 0.25, centreCents: -10};
export const PINCH_VIBRATO: VibratoShape = {delayS: 0.25, depthCents: 40, rateHz: 5.8, fadeInS: 0.25, centreCents: 0};
export const VIBRATO_RELEASE_S = 0.1;

// Feedback: a lead note held past bloomAfterS hands over to its k-th harmonic through two narrow band-passes.
export const FEEDBACK = {
	bloomAfterS: 1.7,
	timeConstantS: 0.45,
	// The note itself fades to this; 0.35 if the bloom sounds too clean.
	mainGainTarget: 0.2,
	level: 3,
	harmonic: 2,
	q: 10,
} as const;

export type PinchMethod = 'comb' | 'shift' | 'spectral';
// B in the prototype (string-node comb filter, prepared at load). 'shift' is A, 'spectral' is C; switch here to
// compare them by ear.
export const PINCH_METHOD: PinchMethod = 'comb';
// The harmonic baked at load; others (see pinchHarmonicFor) are baked the first time they are played.
export const PINCH_HARMONIC = 3;
// The pinch voice drives the amp a little harder.
export const PINCH_VOICE_GAIN = 1.4;
// A new lead note cuts the ringing one, like a fret change.
export const LEAD_CHOKE_S = 0.006;
export const LEAD_RELEASE_S = 0.04;

export const SUSTAIN_LOOP = {startS: 0.45, lengthS: 0.3, crossfadeS: 0.04, correlationWindow: 2048} as const;

// One live amp per player; kutuphane.amfi() as nodes. Gain 35 for rhythm, 50 for lead.
export const AMP = {
	inputHighpassHz: 110,
	midBoost: {hz: 750, gainDb: 9, q: 0.8},
	leadGain: 50,
	bias: 0.15,
	dcHighpassHz: 30,
	secondStageGain: 2.5,
	cabLowpassHz: 5200,
	cabHighpassHz: 85,
	cabPeaks: [
		{hz: 2400, gainDb: 4, q: 1.2},
		{hz: 450, gainDb: -4, q: 1},
		{hz: 120, gainDb: 2.5, q: 0.9},
	],
	echo: {delayS: 0.3, feedback: 0.25, wet: 0.22, lowpassHz: 3500, rightOffsetS: 0.012},
} as const;

export function harmonicSemitones(harmonic: number): number {
	return 12 * Math.log2(harmonic);
}

export function midiToHz(midi: number): number {
	return 440 * 2 ** ((midi - 69) / 12);
}

// Second-order step response from `from` to `to`; the 10-90% rise is about riseS.
export function stepResponse(tS: number, from: number, to: number, riseS: number, zeta: number): number {
	if (tS <= 0) return from;
	const wn = 1.8 / riseS;
	let s: number;
	if (zeta < 1) {
		const wd = wn * Math.sqrt(1 - zeta * zeta);
		s = 1 - Math.exp(-zeta * wn * tS) * (Math.cos(wd * tS) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * tS));
	} else {
		s = 1 - Math.exp(-wn * tS) * (1 + wn * tS);
	}
	return from + (to - from) * s;
}

// How long a step keeps moving noticeably; the automation snaps to the target after this.
export function stepSettleS(riseS: number, zeta: number): number {
	const wn = 1.8 / riseS;
	return Math.min(1.5, Math.max(0.4, 4.6 / (Math.min(zeta, 1) * wn)));
}

export interface PitchPoint {
	readonly time: number;
	readonly cents: number;
}

// Ramp targets for a bend (or its release) starting at `startTime`, every PITCH_STEP_S, ending exactly on `to`.
export function bendPoints(
	startTime: number,
	from: number,
	to: number,
	riseS: number,
	zeta: number,
): ReadonlyArray<PitchPoint> {
	const duration = stepSettleS(riseS, zeta);
	const steps = Math.ceil(duration / PITCH_STEP_S);
	const points: Array<PitchPoint> = [];
	for (let i = 1; i < steps; i++) {
		const t = i * PITCH_STEP_S;
		points.push({time: startTime + t, cents: stepResponse(t, from, to, riseS, zeta)});
	}
	points.push({time: startTime + duration, cents: to});
	return points;
}

export interface GainPoint {
	readonly time: number;
	readonly value: number;
}

// Vibrato depth after a note on: nothing until the hold delay, then a linear fade to full depth.
export function vibratoOnsetPoints(startTime: number, shape: VibratoShape): ReadonlyArray<GainPoint> {
	return [
		{time: startTime + shape.delayS, value: 0},
		{time: startTime + shape.delayS + shape.fadeInS, value: shape.depthCents},
	];
}

// The light hold vibrato a note has at `time` (what a released bend returns to).
export function holdVibratoDepthAt(noteOnTime: number, time: number): number {
	const t = time - noteOnTime - HOLD_VIBRATO.delayS;
	if (t <= 0) return 0;
	return HOLD_VIBRATO.depthCents * Math.min(1, t / HOLD_VIBRATO.fadeInS);
}

// Feedback bloom level at `time` for a note on at noteOnTime (0 before the bloom), normalised to 0..1.
export function feedbackBloomAt(noteOnTime: number, time: number): number {
	const t = time - noteOnTime - FEEDBACK.bloomAfterS;
	return t <= 0 ? 0 : 1 - Math.exp(-t / FEEDBACK.timeConstantS);
}
