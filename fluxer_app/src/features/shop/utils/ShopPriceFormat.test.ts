// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	aznMinorToTryMinor,
	formatAzn,
	formatDiscount,
	formatTry,
	usdCentsToAznMinor,
} from '@app/features/shop/utils/ShopPriceFormat';

import {describe, expect, it} from 'vitest';

describe('ShopPriceFormat', () => {
	it('formats TL and AZN with local decimal separators, never USD', () => {
		expect(formatTry(6800, 'tr')).toBe('68 TL');
		expect(formatTry(6838, 'tr')).toBe('68,38 TL');

		expect(formatTry(500, 'en-US')).toBe('5 TL');

		expect(formatAzn(850, 'tr')).toBe('8,50');
		expect(formatAzn(338, 'tr')).toBe('3,38');

		expect(formatDiscount(20, 'tr')).toBe('-%20');
	});

	it('converts cents using the exact catalog micro rate, equal to the server quote', () => {
		expect(usdCentsToAznMinor(499, 1700000)).toBe(848);

		expect(usdCentsToAznMinor(1299, 1700000)).toBe(2208);

		expect(usdCentsToAznMinor(15, 1700000)).toBe(26);

		// computeShopPrice(10000 cents, rate 1700049) = 17000 qepik; rounded legacy 1.7000 loses precision at 20000 cents.

		expect(usdCentsToAznMinor(20000, 1700049)).toBe(34001);
	});

	it('rounds TL half up from the payable AZN amount and hides absent or stale effective rates', () => {
		expect(aznMinorToTryMinor(848, 40000)).toBe(21200);

		expect(aznMinorToTryMinor(1, 400000)).toBe(3);

		expect(aznMinorToTryMinor(848, null)).toBeNull();

		expect(aznMinorToTryMinor(848, undefined)).toBeNull();
	});
});
