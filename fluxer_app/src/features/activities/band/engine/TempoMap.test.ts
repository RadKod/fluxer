// SPDX-License-Identifier: AGPL-3.0-or-later

import {BeatStrength, TempoMap} from '@app/features/activities/band/engine/TempoMap';
import {describe, expect, it} from 'vitest';

const RES = 480;

describe('TempoMap', () => {
	it('converts ticks to ms across tempo changes and back', () => {
		const map = new TempoMap(
			RES,
			[
				{tick: 0, beatsPerMinute: 120},
				{tick: 960, beatsPerMinute: 60},
			],
			[],
		);
		expect(map.tickToMs(480)).toBe(500);
		expect(map.tickToMs(960)).toBe(1000);
		expect(map.tickToMs(1440)).toBe(2000);
		expect(map.msToTick(2000)).toBe(1440);
		expect(map.msToTick(250)).toBe(240);
	});

	it('defaults to 120 BPM and 4/4 when the chart starts without them', () => {
		const map = new TempoMap(RES, [{tick: 960, beatsPerMinute: 240}], []);
		expect(map.tickToMs(960)).toBe(1000);
		expect(map.tickToMs(1440)).toBe(1250);
		expect(map.timeSignatures).toEqual([{tick: 0, numerator: 4, denominator: 4}]);
	});

	it('ranks ticks by metric strength in 4/4', () => {
		const map = new TempoMap(RES, [], []);
		expect(map.beatStrengthAt(0)).toBe(BeatStrength.Measure);
		expect(map.beatStrengthAt(1920)).toBe(BeatStrength.Measure);
		expect(map.beatStrengthAt(480)).toBe(BeatStrength.Beat);
		expect(map.beatStrengthAt(240)).toBe(BeatStrength.Eighth);
		expect(map.beatStrengthAt(160)).toBe(BeatStrength.EighthTriplet);
		expect(map.beatStrengthAt(120)).toBe(BeatStrength.Sixteenth);
		expect(map.beatStrengthAt(80)).toBe(BeatStrength.SixteenthTriplet);
		expect(map.beatStrengthAt(30)).toBe(BeatStrength.OffGrid);
	});

	it('counts compound meters in dotted quarters', () => {
		const map = new TempoMap(RES, [], [{tick: 0, numerator: 6, denominator: 8}]);
		expect(map.beatTicksAt(0)).toBe(720);
		expect(map.beatStrengthAt(720)).toBe(BeatStrength.Beat);
		expect(map.beatStrengthAt(1440)).toBe(BeatStrength.Measure);
		expect(map.beatStrengthAt(240)).toBe(BeatStrength.EighthTriplet);
		expect(map.beatMsAt(0)).toBe(750);
	});

	it('resets the bar grid at each time signature change', () => {
		const map = new TempoMap(
			RES,
			[],
			[
				{tick: 0, numerator: 4, denominator: 4},
				{tick: 2400, numerator: 3, denominator: 4},
			],
		);
		// Bar 0 (0..1920), a cut-short bar 1 (1920..2400), then 3/4 bars of 1440 ticks.
		expect(map.measureIndexAt(1919)).toBe(0);
		expect(map.measureIndexAt(1920)).toBe(1);
		expect(map.measureIndexAt(2400)).toBe(2);
		expect(map.measureIndexAt(3840)).toBe(3);
		expect(map.beatStrengthAt(2400)).toBe(BeatStrength.Measure);
		expect(map.beatStrengthAt(3840)).toBe(BeatStrength.Measure);
	});

	it('reports grid step lengths at the local tempo', () => {
		const map = new TempoMap(RES, [{tick: 0, beatsPerMinute: 150}], []);
		expect(map.gridStepMsAt(0, BeatStrength.Measure)).toBe(400);
		expect(map.gridStepMsAt(0, BeatStrength.Eighth)).toBe(200);
		expect(map.gridStepMsAt(0, BeatStrength.Sixteenth)).toBe(100);
		expect(map.gridStepMsAt(0, BeatStrength.OffGrid)).toBe(0);
	});
});
