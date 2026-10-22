// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	isWhammyPart,
	WHAMMY,
	WHAMMY_OFF,
	WhammyInput,
	whammyDelaySwingS,
	whammyModulation,
} from '@app/features/activities/band/game/Whammy';
import {describe, expect, it} from 'vitest';

// The pitch a delay line swinging by `swing` seconds at `rateHz` reaches at its fastest, in cents.
function peakCents(swing: number, rateHz: number): number {
	return 1200 * Math.log2(1 + 2 * Math.PI * rateHz * swing);
}

describe('whammy', () => {
	it('belongs to the guitars and the bass', () => {
		expect(['guitar', 'rhythm', 'bass', 'keys', 'drums', 'vocals'].map((part) => isWhammyPart(part as never))).toEqual([
			true,
			true,
			true,
			false,
			false,
			false,
		]);
	});

	it('bends gently on one press and deeper and faster the faster the key is pumped', () => {
		expect(whammyModulation(null)).toEqual({depthCents: WHAMMY.gentleDepthCents, rateHz: WHAMMY.defaultRateHz});
		expect(whammyModulation(WHAMMY.slowIntervalMs)).toEqual({
			depthCents: WHAMMY.gentleDepthCents,
			rateHz: WHAMMY.minRateHz,
		});
		const fast = whammyModulation(WHAMMY.fastIntervalMs);
		expect(fast.depthCents).toBe(WHAMMY.maxDepthCents);
		expect(fast.rateHz).toBeCloseTo(1000 / 180);
		expect(whammyModulation(80).rateHz).toBe(WHAMMY.maxRateHz);
		expect(whammyModulation(5_000)).toEqual(whammyModulation(null));
	});

	it('swings the delay just enough to reach the depth, and never past the base delay', () => {
		for (const modulation of [whammyModulation(null), whammyModulation(WHAMMY.fastIntervalMs)]) {
			const swing = whammyDelaySwingS(modulation);
			expect(peakCents(swing, modulation.rateHz)).toBeCloseTo(modulation.depthCents, 6);
			expect(swing).toBeLessThan(WHAMMY.baseDelayS);
		}
		expect(whammyDelaySwingS(WHAMMY_OFF)).toBe(0);
		expect(whammyDelaySwingS({depthCents: 1200, rateHz: 1})).toBe(WHAMMY.baseDelayS * 0.9);
	});

	it('times the wobble from the presses and lets go on release', () => {
		const input = new WhammyInput();
		expect(input.press(1_000).depthCents).toBe(WHAMMY.gentleDepthCents);
		expect(input.pressed).toBe(true);
		expect(input.release()).toEqual(WHAMMY_OFF);
		expect(input.pressed).toBe(false);
		expect(input.press(1_250)).toEqual(whammyModulation(250));
	});
});
