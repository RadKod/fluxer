// SPDX-License-Identifier: AGPL-3.0-or-later

import {cosmeticSeriesSlug, normalizeCosmeticSeriesName} from '@fluxer/constants/src/CosmeticSeries';
import {describe, expect, it} from 'vitest';

describe('cosmetic series', () => {
	it('normalizes whitespace and treats an empty name as no series', () => {
		expect(normalizeCosmeticSeriesName('  Jujutsu   Kaisen ')).toBe('Jujutsu Kaisen');
		expect(normalizeCosmeticSeriesName('   ')).toBeNull();
		expect(normalizeCosmeticSeriesName(null)).toBeNull();
	});

	it('derives one slug for spellings that differ only in case, spacing or Turkish letters', () => {
		expect(cosmeticSeriesSlug('Jujutsu Kaisen')).toBe('jujutsu-kaisen');
		expect(cosmeticSeriesSlug('jujutsu kaisen ')).toBe('jujutsu-kaisen');
		expect(cosmeticSeriesSlug('All Ears')).toBe('all-ears');
		expect(cosmeticSeriesSlug('Işıklı Şehir')).toBe('isikli-sehir');
		expect(cosmeticSeriesSlug('Chibi Café')).toBe('chibi-cafe');
		expect(cosmeticSeriesSlug('---')).toBeNull();
	});
});
