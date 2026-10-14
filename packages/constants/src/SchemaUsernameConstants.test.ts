// SPDX-License-Identifier: AGPL-3.0-or-later

import {AdminACLs, filterKnownAdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {describe, expect, it} from 'vitest';

describe('username constants contract', () => {
	it.each([
		'TAKEN',
		'RESERVED',
		'BLOCKED',
		'RELEASE_EMBARGO',
		'COOLDOWN',
		'BUSY',
		'RATE_LIMITED',
		'INVALID',
		'RESERVED_TERM',
		'TOO_SHORT',
		'REQUIRES_ENTITLEMENT',
		'UNAVAILABLE',
		'SELECTION_REQUIRED',
	])('exports a distinct username %s error code', (reason) => {
		const code = `USERNAME_${reason}`;
		expect(APIErrorCodes[code as keyof typeof APIErrorCodes]).toBe(code);
	});

	it('registers reserve and migration permissions separately from username edits', () => {
		expect(AdminACLs).toMatchObject({
			USERNAME_RESERVE: 'username:reserve',
			USERNAME_MIGRATION_START: 'username:migration:start',
			USER_UPDATE_USERNAME: 'user:update:username',
		});
		expect(filterKnownAdminACLs(['username:reserve', 'username:migration:start', 'username:unknown'])).toEqual([
			'username:reserve',
			'username:migration:start',
		]);
	});
});
