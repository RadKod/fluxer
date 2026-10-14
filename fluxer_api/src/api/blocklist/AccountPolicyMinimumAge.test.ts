// SPDX-License-Identifier: AGPL-3.0-or-later

import {getMinimumRegistrationAge} from '@app/api/auth/AuthRegistration';
import {getRegionalMinimumAge} from '@fluxer/constants/src/RegionalMinimumAge';
import {describe, expect, it} from 'vitest';

describe('registration minimum age', () => {
	it.each([null, undefined, '', '  '])('requires 15 when GeoIP resolves no country (%j)', (country) => {
		expect(getMinimumRegistrationAge(country)).toBe(15);
	});

	it.each(['ZZ', 'US', 'AT'])('raises the lower regional minimum of %s to 15', (country) => {
		expect(getRegionalMinimumAge(country)).toBeLessThan(15);
		expect(getMinimumRegistrationAge(country)).toBe(15);
	});

	it('requires 15 for registration in Turkey', () => {
		expect(getMinimumRegistrationAge('TR')).toBe(15);
		expect(getMinimumRegistrationAge(' tr ')).toBe(15);
	});

	it('preserves stricter regional limits and normalized country codes', () => {
		expect(getMinimumRegistrationAge('DE')).toBe(16);
		expect(getMinimumRegistrationAge('FR')).toBe(15);
		expect(getMinimumRegistrationAge('DE')).toBe(getRegionalMinimumAge('DE'));
		expect(getMinimumRegistrationAge(' de ')).toBe(getMinimumRegistrationAge('DE'));
	});
});
