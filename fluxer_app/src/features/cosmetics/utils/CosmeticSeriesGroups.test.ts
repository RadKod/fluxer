// SPDX-License-Identifier: AGPL-3.0-or-later

import {cosmeticMatchesQuery, groupCosmeticsBySeries} from '@app/features/cosmetics/utils/CosmeticSeriesGroups';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {describe, expect, it} from 'vitest';

const item = (id: string, name: string, series: string | null): CosmeticItemResponse => ({
	id,
	type: 'avatar_decoration',
	name,
	description: null,
	series,
	asset: id,
	availability: 'premium',
});

describe('cosmetic series groups', () => {
	it('groups by slug in Turkish name order and puts items without a series last', () => {
		const groups = groupCosmeticsBySeries([
			item('1', 'Neon', 'Arcade'),
			item('2', 'Loose', null),
			item('3', 'Ears', 'All Ears'),
			item('4', 'Stick', 'arcade '),
			item('5', 'Şapka', 'Çiçek'),
		]);
		expect(groups.map((group) => [group.slug, group.name, group.items.map((i) => i.id)])).toEqual([
			['all-ears', 'All Ears', ['3']],
			['arcade', 'Arcade', ['1', '4']],
			['cicek', 'Çiçek', ['5']],
			['other', null, ['2']],
		]);
	});

	it('matches a query against the name or the series without case or accents', () => {
		const jjk = item('1', 'Gojo', 'Jujutsu Kaisen');
		expect(cosmeticMatchesQuery(jjk, 'jujutsu')).toBe(true);
		expect(cosmeticMatchesQuery(jjk, 'GOJO')).toBe(true);
		expect(cosmeticMatchesQuery(jjk, 'arcade')).toBe(false);
		expect(cosmeticMatchesQuery(jjk, '   ')).toBe(true);
	});
});
