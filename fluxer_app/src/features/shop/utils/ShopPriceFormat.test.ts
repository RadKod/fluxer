// SPDX-License-Identifier: AGPL-3.0-or-later

import {formatDiscount, formatTry, percentOff, shownTryMinor} from '@app/features/shop/utils/ShopPriceFormat';

import {describe, expect, it} from 'vitest';

describe('ShopPriceFormat', () => {
	// sanalyer: Turkish lira is the only shop currency.
	it('formats kuruş as Turkish lira with local separators, dropping decimals on whole lira', () => {
		expect(formatTry(15000, 'tr')).toBe('₺150');
		expect(formatTry(14999, 'tr')).toBe('₺149,99');
		expect(formatTry(14950, 'tr')).toBe('₺149,50');

		expect(formatTry(500, 'en-US')).toBe('₺5');
		expect(formatTry(1250, 'en-US')).toBe('₺12.50');

		expect(formatDiscount(20, 'tr')).toBe('-%20');
	});

	it('takes a percent off rounded half up, like the server', () => {
		expect(percentOff(14999, 20)).toBe(11999);
		expect(percentOff(15, 50)).toBe(8);
	});

	it('shows the campaign price only while the campaign runs', () => {
		const price = {
			base_try_minor: 10000,
			campaign_percent: 20,
			campaign_ends_at: '2026-10-01T00:00:00.000Z',
			sale_try_minor: 8000,
			premium_try_minor: null,
		};
		expect(shownTryMinor(price, Date.parse('2026-09-30T00:00:00.000Z'))).toBe(8000);
		expect(shownTryMinor(price, Date.parse('2026-10-02T00:00:00.000Z'))).toBe(10000);
	});
});
