// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	contrastRatio,
	deltaE2000,
	GRADIENT_SAMPLE_COUNT,
	gradientSamples,
	isNameColorsReadableOnDark,
	isNameColorsReadableOnLight,
	type Lab,
	labDeltaE2000,
	NAME_COLOR_DARK_BACKGROUNDS,
	NAME_COLOR_LIGHT_BACKGROUND,
	NAME_COLOR_LIGHT_MIN_CONTRAST,
	NAME_COLOR_MIN_CONTRAST,
	NAME_COLOR_ROLE_MIN_DELTA_E,
	relativeLuminance,
	srgbToLab,
} from '@fluxer/constants/src/ColorContrast';
import {describe, expect, it} from 'vitest';

describe('WCAG luminance and contrast', () => {
	it('matches the WCAG reference values', () => {
		expect(relativeLuminance(0xffffff)).toBeCloseTo(1, 10);
		expect(relativeLuminance(0x000000)).toBe(0);
		expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 10);
		expect(contrastRatio(0x777777, 0xffffff)).toBeCloseTo(4.48, 2);
	});

	it('is symmetric', () => {
		expect(contrastRatio(0x7b5cff, 0x1e1b4b)).toBe(contrastRatio(0x1e1b4b, 0x7b5cff));
	});
});

describe('gradientSamples', () => {
	it('samples a two-stop gradient every 5 %, mixing the sRGB channels as the browser paints it', () => {
		const samples = gradientSamples([0xff0000, 0x00ff00]);
		expect(GRADIENT_SAMPLE_COUNT).toBe(21);
		expect(samples).toHaveLength(21);
		expect(samples[0]).toBe(0xff0000);
		expect(samples[20]).toBe(0x00ff00);
		expect(samples[10]).toBe(0x808000);
		expect(samples[1]).toBe(0xf20d00);
		expect(gradientSamples([0x000000, 0xffffff])[10]).toBe(0x808080);
		expect(new Set(gradientSamples([0x123456, 0x123456]))).toEqual(new Set([0x123456]));
	});

	it('keeps a solid colour as it is', () => {
		expect(gradientSamples([0x7b5cff])).toEqual([0x7b5cff]);
	});
});

describe('srgbToLab', () => {
	it('maps white, black and red to their CIELAB (D65) values', () => {
		const white = srgbToLab(0xffffff);
		expect(white[0]).toBeCloseTo(100, 3);
		expect(white[1]).toBeCloseTo(0, 3);
		expect(white[2]).toBeCloseTo(0, 3);
		expect(srgbToLab(0x000000)).toEqual([0, 0, 0]);
		const red = srgbToLab(0xff0000);
		expect(red[0]).toBeCloseTo(53.2408, 1);
		expect(red[1]).toBeCloseTo(80.0925, 1);
		expect(red[2]).toBeCloseTo(67.2032, 1);
	});
});

// Sharma, Wu and Dalal (2005), "The CIEDE2000 color-difference formula", Table 1: the 34 published test pairs.
const SHARMA_PAIRS: ReadonlyArray<readonly [Lab, Lab, number]> = [
	[[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
	[[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
	[[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
	[[50, -1.3802, -84.2814], [50, 0, -82.7485], 1],
	[[50, -1.1848, -84.8006], [50, 0, -82.7485], 1],
	[[50, -0.9009, -85.5211], [50, 0, -82.7485], 1],
	[[50, 0, 0], [50, -1, 2], 2.3669],
	[[50, -1, 2], [50, 0, 0], 2.3669],
	[[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
	[[50, 2.49, -0.001], [50, -2.49, 0.001], 7.1792],
	[[50, 2.49, -0.001], [50, -2.49, 0.0011], 7.2195],
	[[50, 2.49, -0.001], [50, -2.49, 0.0012], 7.2195],
	[[50, -0.001, 2.49], [50, 0.0009, -2.49], 4.8045],
	[[50, -0.001, 2.49], [50, 0.001, -2.49], 4.8045],
	[[50, -0.001, 2.49], [50, 0.0011, -2.49], 4.7461],
	[[50, 2.5, 0], [50, 0, -2.5], 4.3065],
	[[50, 2.5, 0], [73, 25, -18], 27.1492],
	[[50, 2.5, 0], [61, -5, 29], 22.8977],
	[[50, 2.5, 0], [56, -27, -3], 31.903],
	[[50, 2.5, 0], [58, 24, 15], 19.4535],
	[[50, 2.5, 0], [50, 3.1736, 0.5854], 1],
	[[50, 2.5, 0], [50, 3.2972, 0], 1],
	[[50, 2.5, 0], [50, 1.8634, 0.5757], 1],
	[[50, 2.5, 0], [50, 3.2592, 0.335], 1],
	[[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
	[[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
	[[61.2901, 3.7196, -5.3901], [61.4292, 2.248, -4.962], 1.8731],
	[[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
	[[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
	[[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
	[[90.8027, -2.0831, 1.441], [91.1528, -1.6435, 0.0447], 1.4441],
	[[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
	[[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
	[[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
];

describe('labDeltaE2000', () => {
	it.each(SHARMA_PAIRS.map(([a, b, expected], index) => [index + 1, a, b, expected] as const))(
		'Sharma pair %i',
		(_index, a, b, expected) => {
			expect(labDeltaE2000(a, b)).toBeCloseTo(expected, 3);
			expect(labDeltaE2000(b, a)).toBeCloseTo(expected, 3);
		},
	);

	it('is zero for the same colour', () => {
		expect(labDeltaE2000([42, 10, -20], [42, 10, -20])).toBe(0);
	});
});

describe('deltaE2000', () => {
	it('compares sRGB integers', () => {
		expect(deltaE2000(0xe74c3c, 0xe74c3c)).toBe(0);
		expect(deltaE2000(0xe74c3c, 0xe74c3d)).toBeLessThan(1);
		expect(deltaE2000(0xff0000, 0x0000ff)).toBeGreaterThan(NAME_COLOR_ROLE_MIN_DELTA_E);
		expect(deltaE2000(0x000000, 0xffffff)).toBeCloseTo(100, 3);
	});
});

describe('name colour thresholds', () => {
	it('pins the chat backgrounds and the thresholds', () => {
		expect(NAME_COLOR_DARK_BACKGROUNDS).toEqual([0x141519, 0x0b0c0e]);
		expect(NAME_COLOR_LIGHT_BACKGROUND).toBe(0xfbfbfc);
		expect(NAME_COLOR_MIN_CONTRAST).toBe(4.5);
		expect(NAME_COLOR_LIGHT_MIN_CONTRAST).toBe(3);
		expect(NAME_COLOR_ROLE_MIN_DELTA_E).toBe(15);
	});
});

describe('isNameColorsReadableOnDark', () => {
	it('needs 4.5:1 against the dark chat background', () => {
		expect(isNameColorsReadableOnDark([0xffffff])).toBe(true);
		expect(isNameColorsReadableOnDark([0x808080])).toBe(true);
		expect(isNameColorsReadableOnDark([0x7d7d7d])).toBe(false);
		expect(isNameColorsReadableOnDark([0x000000])).toBe(false);
	});

	it('needs every colour of a gradient to pass', () => {
		expect(isNameColorsReadableOnDark([0xffffff, 0x3a3a3a])).toBe(false);
		expect(isNameColorsReadableOnDark([0x3a3a3a, 0xffffff])).toBe(false);
		expect(isNameColorsReadableOnDark([0xffffff, 0x00ff00])).toBe(true);
	});

	it('also checks the gradient midpoint, which can be darker than both ends', () => {
		expect(contrastRatio(0xff0000, NAME_COLOR_DARK_BACKGROUNDS[0])).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(0x00ff00, NAME_COLOR_DARK_BACKGROUNDS[0])).toBeGreaterThanOrEqual(4.5);
		expect(isNameColorsReadableOnDark([0xff0000, 0x00ff00])).toBe(false);
	});

	it('checks the whole gradient, which can dip below 4.5:1 away from the ends and the midpoint', () => {
		const colors = [0x0ff87d, 0xec03b9];
		const background = NAME_COLOR_DARK_BACKGROUNDS[0];
		expect(contrastRatio(colors[0], background)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(colors[1], background)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(gradientSamples(colors)[10], background)).toBeGreaterThanOrEqual(4.5);
		expect(Math.min(...gradientSamples(colors).map((color) => contrastRatio(color, background)))).toBeCloseTo(3.72, 2);
		expect(isNameColorsReadableOnDark(colors)).toBe(false);
	});

	it('rejects an empty or over-long colour list', () => {
		expect(isNameColorsReadableOnDark([])).toBe(false);
		expect(isNameColorsReadableOnDark([0xffffff, 0xffffff, 0xffffff])).toBe(false);
	});
});

describe('isNameColorsReadableOnLight', () => {
	it('keeps colours at 3:1 or more against the light chat background and drops the rest', () => {
		expect(isNameColorsReadableOnLight([0x000000])).toBe(true);
		expect(isNameColorsReadableOnLight([0x929292])).toBe(true);
		expect(isNameColorsReadableOnLight([0x939393])).toBe(false);
		expect(isNameColorsReadableOnLight([0xffff00])).toBe(false);
		expect(isNameColorsReadableOnLight([0x000000, 0xffff00])).toBe(false);
		expect(isNameColorsReadableOnLight([0xff0000, 0x0000ff])).toBe(true);
	});

	it('rejects an empty or over-long colour list', () => {
		expect(isNameColorsReadableOnLight([])).toBe(false);
		expect(isNameColorsReadableOnLight([0, 0, 0])).toBe(false);
	});
});
