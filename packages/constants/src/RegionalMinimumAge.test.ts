// SPDX-License-Identifier: AGPL-3.0-or-later

import {DEFAULT_MINIMUM_AGE, getRegionalMinimumAge} from '@fluxer/constants/src/RegionalMinimumAge';
import {describe, expect, it} from 'vitest';

describe('upstream regional minimum ages', () => {
	it.each([null, undefined, '', 'ZZ', 'US'])('defaults to 13 for %s', (country) => {
		expect(DEFAULT_MINIMUM_AGE).toBe(13);
		expect(getRegionalMinimumAge(country)).toBe(13);
	});

	it('requires 15 in Turkey', () => {
		expect(getRegionalMinimumAge('TR')).toBe(15);
		expect(getRegionalMinimumAge(' tr ')).toBe(15);
	});

	it.each([
		['AT', 14],
		['AW', 16],
		['BG', 14],
		['BQ', 16],
		['CL', 14],
		['CO', 14],
		['CW', 16],
		['CY', 14],
		['CZ', 15],
		['DE', 16],
		['ES', 14],
		['FR', 15],
		['GR', 15],
		['HR', 16],
		['HU', 16],
		['IE', 16],
		['IT', 14],
		['KR', 14],
		['LT', 14],
		['LU', 16],
		['NL', 16],
		['PE', 14],
		['PL', 16],
		['RO', 16],
		['RS', 15],
		['SI', 16],
		['SK', 16],
		['SM', 16],
		['SX', 16],
		['VE', 14],
		['VN', 15],
	])('keeps the upstream exception for %s at %i', (country, age) => {
		expect(getRegionalMinimumAge(country)).toBe(age);
		expect(getRegionalMinimumAge(` ${country.toLowerCase()} `)).toBe(age);
	});
});
