// SPDX-License-Identifier: AGPL-3.0-or-later

import {type ParamSink, ParamTimeline} from '@app/features/activities/band/jam/JamParamTimeline';
import {
	BEND_RELEASE_RISE_S,
	BEND_RELEASE_ZETA,
	BEND_SHAPES,
	BEND_ZETA,
	bendPoints,
	FEEDBACK,
	feedbackBloomAt,
	HOLD_VIBRATO,
	harmonicSemitones,
	holdVibratoDepthAt,
	PITCH_STEP_S,
	stepResponse,
	stepSettleS,
	vibratoOnsetPoints,
} from '@app/features/activities/band/jam/JamTechniques';
import {describe, expect, it} from 'vitest';

describe('bend curves', () => {
	it('overshoots a whole-step bend by about 18 cents and settles on it', () => {
		const {cents, riseS} = BEND_SHAPES[2];
		let peak = 0;
		for (let t = 0; t < 1; t += 0.001) peak = Math.max(peak, stepResponse(t, 0, cents, riseS, BEND_ZETA));
		expect(peak - cents).toBeGreaterThan(15);
		expect(peak - cents).toBeLessThan(21);
		expect(stepResponse(1, 0, cents, riseS, BEND_ZETA)).toBeCloseTo(cents, 0);
	});

	it('rises 10-90% in about the shape’s rise time', () => {
		for (const {cents, riseS} of Object.values(BEND_SHAPES)) {
			const crossing = (level: number) => {
				for (let t = 0; t < 1; t += 0.0005) if (stepResponse(t, 0, cents, riseS, BEND_ZETA) >= level * cents) return t;
				return 1;
			};
			const rise = crossing(0.9) - crossing(0.1);
			expect(rise).toBeGreaterThan(riseS * 0.6);
			expect(rise).toBeLessThan(riseS * 1.2);
		}
	});

	it('releases without overshooting below the note much', () => {
		let low = 200;
		for (let t = 0; t < 1; t += 0.001)
			low = Math.min(low, stepResponse(t, 200, 0, BEND_RELEASE_RISE_S, BEND_RELEASE_ZETA));
		expect(low).toBeGreaterThan(-1);
	});

	it('lays down ramp points every step that end exactly on the target', () => {
		const points = bendPoints(3, 40, 300, BEND_SHAPES[3].riseS, BEND_ZETA);
		const settle = stepSettleS(BEND_SHAPES[3].riseS, BEND_ZETA);
		expect(points[0].time).toBeCloseTo(3 + PITCH_STEP_S, 9);
		expect(points[points.length - 1]).toEqual({time: 3 + settle, cents: 300});
		for (let i = 1; i < points.length; i++) expect(points[i].time).toBeGreaterThan(points[i - 1].time);
		expect(points[0].cents).toBeGreaterThan(40);
		expect(settle).toBeGreaterThanOrEqual(0.4);
		expect(settle).toBeLessThanOrEqual(1.5);
	});
});

describe('hold-time techniques', () => {
	it('fades the hold vibrato in after the hold delay', () => {
		expect(holdVibratoDepthAt(10, 10.5)).toBe(0);
		expect(holdVibratoDepthAt(10, 10 + HOLD_VIBRATO.delayS + HOLD_VIBRATO.fadeInS / 2)).toBeCloseTo(
			HOLD_VIBRATO.depthCents / 2,
			9,
		);
		expect(holdVibratoDepthAt(10, 20)).toBe(HOLD_VIBRATO.depthCents);
		expect(vibratoOnsetPoints(10, HOLD_VIBRATO)).toEqual([
			{time: 10.6, value: 0},
			{time: 10.85, value: HOLD_VIBRATO.depthCents},
		]);
	});

	it('blooms feedback from 1.7 s with a 0.45 s time constant', () => {
		expect(feedbackBloomAt(0, FEEDBACK.bloomAfterS)).toBe(0);
		expect(feedbackBloomAt(0, FEEDBACK.bloomAfterS + FEEDBACK.timeConstantS)).toBeCloseTo(1 - Math.exp(-1), 9);
		expect(feedbackBloomAt(0, 10)).toBeGreaterThan(0.999);
	});

	it('knows the harmonic intervals', () => {
		expect(harmonicSemitones(2)).toBe(12);
		expect(harmonicSemitones(3)).toBeCloseTo(19.02, 2);
		expect(harmonicSemitones(5)).toBeCloseTo(27.86, 2);
	});
});

describe('ParamTimeline', () => {
	it('follows sets, ramps and targets', () => {
		const timeline = new ParamTimeline(1);
		timeline.set(1, 0);
		timeline.rampTo(2, 10);
		timeline.target(3, 0, 0.5);
		expect(timeline.valueAt(0.5)).toBe(1);
		expect(timeline.valueAt(1.5)).toBeCloseTo(5, 9);
		expect(timeline.valueAt(2.5)).toBe(10);
		expect(timeline.valueAt(3.5)).toBeCloseTo(10 * Math.exp(-1), 9);
	});

	it('holds mid-ramp and mid-target, mirroring the param', () => {
		const calls: Array<string> = [];
		const sink: ParamSink = {
			setValueAtTime: (v, t) => calls.push(`set ${v} ${t}`),
			linearRampToValueAtTime: (v, t) => calls.push(`ramp ${v} ${t}`),
			setTargetAtTime: (v, t, c) => calls.push(`target ${v} ${t} ${c}`),
			cancelScheduledValues: (t) => calls.push(`cancel ${t}`),
		};
		const timeline = new ParamTimeline(0, sink);
		timeline.set(0, 0);
		timeline.rampTo(1, 100);
		expect(timeline.hold(0.25)).toBeCloseTo(25, 9);
		timeline.rampTo(0.5, 0);
		expect(timeline.valueAt(0.375)).toBeCloseTo(12.5, 9);
		expect(timeline.valueAt(2)).toBe(0);
		expect(calls).toEqual(['set 0 0', 'ramp 100 1', 'cancel 0.25', 'set 25 0.25', 'ramp 0 0.5']);

		const bloom = new ParamTimeline(1);
		bloom.target(1, 0.2, 0.45);
		const held = bloom.hold(1.45);
		expect(held).toBeCloseTo(0.2 + 0.8 * Math.exp(-1), 9);
		expect(bloom.valueAt(5)).toBeCloseTo(held, 9);
	});
});
