// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveDeletionDays} from '@app/api/admin/services/AdminUserDeletionService';
import {getMinimumRegistrationAge} from '@app/api/auth/AuthRegistration';
import {DeletionReasons} from '@fluxer/constants/src/Core';
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

	it('keeps the child safety deletion minimum at 60 days', () => {
		expect(resolveDeletionDays(DeletionReasons.CHILD_SAFETY_VIOLATION, 1)).toBe(60);
		expect(resolveDeletionDays(DeletionReasons.CHILD_SAFETY_VIOLATION, 70)).toBe(70);
	});
});
