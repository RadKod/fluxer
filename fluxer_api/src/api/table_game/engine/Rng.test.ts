// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {CryptoRng} from '@app/api/table_game/engine/Rng';
import {afterEach, describe, expect, test, vi} from 'vitest';

describe('CryptoRng', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('CryptoRng.int delegates to crypto.randomInt (spy) and stays in [0, n)', () => {
		const spy = vi.spyOn(crypto, 'randomInt');
		for (const n of [1, 2, 4, 106]) {
			for (let i = 0; i < 200; i++) {
				const value = CryptoRng.int(n);
				expect(Number.isInteger(value)).toBe(true);
				expect(value).toBeGreaterThanOrEqual(0);
				expect(value).toBeLessThan(n);
			}
		}
		expect(spy).toHaveBeenCalledTimes(800);
		expect(spy).toHaveBeenLastCalledWith(106);
	});
});
