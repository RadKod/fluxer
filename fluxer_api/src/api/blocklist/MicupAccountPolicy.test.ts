// SPDX-License-Identifier: AGPL-3.0-or-later

import {getMinimumRegistrationAge} from '@app/api/auth/AuthRegistration';
import {getRegionalMinimumAge} from '@fluxer/constants/src/RegionalMinimumAge';
import {describe, expect, it} from 'vitest';

describe('sanalyer upstream registration age contract', () => {
	it.each([null, undefined, '', 'TR', 'DE', 'US', 'ZZ', 'AT', 'FR'])(
		'never admits under 15 and keeps a stricter regional minimum in %j',
		(country) => {
			expect(getMinimumRegistrationAge(country)).toBeGreaterThanOrEqual(15);
			expect(getMinimumRegistrationAge(country)).toBe(Math.max(15, getRegionalMinimumAge(country)));
		},
	);
});
