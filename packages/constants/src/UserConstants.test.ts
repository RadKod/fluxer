// SPDX-License-Identifier: AGPL-3.0-or-later

import {PUBLIC_USER_FLAGS, PublicUserFlags, UserFlags} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it} from 'vitest';

const bitsOf = (mask: bigint) =>
	Array.from(mask.toString(2))
		.reverse()
		.flatMap((digit, bit) => (digit === '1' ? [bit] : []));

describe('UserFlags', () => {
	it('gives every flag its own single bit', () => {
		const values = Object.values(UserFlags);
		expect(values.filter((value) => bitsOf(value).length !== 1)).toEqual([]);
		expect(new Set(values).size).toBe(values.length);
	});

	// fluxer_common/src/user_flags.rs pins the same public bits; change both together. Micup: PREMIUM_BADGE is the
	// only public bit outside the stored mask; Rust derives it in public_user_flags.
	it('exposes exactly the public bits, VERIFIED (29) included', () => {
		expect(bitsOf(PUBLIC_USER_FLAGS)).toEqual([0, 2, 3, 4, 5, 6, 29]);
		expect(Object.values(PublicUserFlags).reduce((mask, flag) => mask | flag, 0)).toBe(
			Number(PUBLIC_USER_FLAGS) | PublicUserFlags.PREMIUM_BADGE,
		);
	});

	it('keeps PREMIUM_BADGE (30) a derived public bit: below 31, outside UserFlags and outside the stored public mask', () => {
		expect(PublicUserFlags.PREMIUM_BADGE).toBe(1 << 30);
		expect(Object.values(UserFlags)).not.toContain(1n << 30n);
		expect(PUBLIC_USER_FLAGS & (1n << 30n)).toBe(0n);
		expect(PublicUserFlags.PREMIUM_BADGE).toBeGreaterThan(0);
		expect(PublicUserFlags.PREMIUM_BADGE).toBeLessThan(2 ** 31);
	});
});
