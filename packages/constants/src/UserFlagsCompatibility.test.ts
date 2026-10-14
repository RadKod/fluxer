// SPDX-License-Identifier: AGPL-3.0-or-later

import {LEGACY_DEAD_USER_FLAGS_MASK, UserFlags} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it} from 'vitest';

describe('Micup account flag compatibility', () => {
	it.each([
		['DISABLED_SUSPICIOUS_ACTIVITY', 35n],
		['FORCE_INBOUND_PHONE_VERIFICATION', 61n],
		['NOT_SUSPICIOUS', 62n],
	])('keeps %s at its stored position', (name, bit) => {
		expect(UserFlags[name as keyof typeof UserFlags]).toBe(1n << bit);
		expect(LEGACY_DEAD_USER_FLAGS_MASK & (1n << bit)).toBe(0n);
	});

	it('allocates LIMIT_EXEMPT a unique previously unused signed-bigint bit', () => {
		expect(UserFlags.LIMIT_EXEMPT).toBe(1n << 59n);
		expect(new Set(Object.values(UserFlags)).size).toBe(Object.keys(UserFlags).length);
		expect(LEGACY_DEAD_USER_FLAGS_MASK & UserFlags.LIMIT_EXEMPT).toBe(0n);
	});
});
