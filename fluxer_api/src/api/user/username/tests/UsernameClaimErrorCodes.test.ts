// SPDX-License-Identifier: AGPL-3.0-or-later

import {USERNAME_CLAIM_ERROR_CODES} from '@app/api/user/username/UsernameOwnershipService';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {describe, expect, it} from 'vitest';

describe('USERNAME_CLAIM_ERROR_CODES', () => {
	it('maps every claim and policy rejection to its USERNAME_ wire code', () => {
		expect(Object.keys(USERNAME_CLAIM_ERROR_CODES).sort()).toEqual(
			[
				'BLOCKED',
				'BUSY',
				'COOLDOWN',
				'INVALID',
				'RATE_LIMITED',
				'RELEASE_EMBARGO',
				'REQUIRES_ENTITLEMENT',
				'RESERVED',
				'RESERVED_TERM',
				'TAKEN',
				'TOO_SHORT',
				'UNAVAILABLE',
			].sort(),
		);
		for (const [reason, code] of Object.entries(USERNAME_CLAIM_ERROR_CODES)) {
			expect(code).toBe(APIErrorCodes[`USERNAME_${reason}` as keyof typeof APIErrorCodes]);
		}
	});
});
