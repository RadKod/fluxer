// SPDX-License-Identifier: AGPL-3.0-or-later

import {buildShopCollections} from '@app/features/shop/utils/ShopCollections';
import type {ShopBundleEntry, ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import {describe, expect, it} from 'vitest';

const price = {
	base_try_minor: 500,
	sale_try_minor: 500,
	premium_try_minor: null,
	campaign_percent: null,
	campaign_ends_at: null,
};
const item = (id: string, type: ShopItemEntry['item']['type'] = 'avatar_ultra', series?: string): ShopItemEntry => ({
	kind: 'item',
	sku: `cosmetic:${id}`,
	item: {id, type, name: id, description: null, series: series ?? null, asset: id, availability: 'owned'},
	price,
});
const bundle = (id: string, items: Array<ShopItemEntry>): ShopBundleEntry => ({
	kind: 'bundle',
	sku: `bundle:${id}`,
	price,
	bundle: {id, sku: `bundle:${id}`, name: id, description: null, items: items.map((entry) => entry.item), price},
});

describe('buildShopCollections', () => {
	// sanalyer: items outside every bundle sit in one row per series, in name order, and the rest in "other" last.
	it('groups loose items by series slug and keeps items without a series in other', () => {
		const neon = item('neon', 'avatar_decoration', 'Arcade');
		const stick = item('stick', 'avatar_decoration', 'arcade ');
		const ears = item('ears', 'nameplate', 'All Ears');
		const loose = item('loose', 'nameplate');
		const result = buildShopCollections([neon, stick, ears, loose], [], 'all');
		expect(result.map((group) => [group.id, group.series, group.entries.map((entry) => entry.sku)])).toEqual([
			['series:all-ears', 'All Ears', ['cosmetic:ears']],
			['series:arcade', 'Arcade', ['cosmetic:neon', 'cosmetic:stick']],
			['other', null, ['cosmetic:loose']],
		]);
	});

	it('assigns shared items once to the first bundle and preserves every bundle card', () => {
		const a = item('a');
		const b = item('b', 'nameplate');
		const other = item('other');
		const first = bundle('first', [a, b]);
		const second = bundle('second', [a]);
		const result = buildShopCollections([a, b, other], [first, second], 'all');
		expect(result.map((group) => [group.id, group.entries.map((entry) => entry.sku)])).toEqual([
			['bundle:first', ['bundle:first', 'cosmetic:a', 'cosmetic:b']],
			['other', ['cosmetic:other']],
			['bundle:second', ['bundle:second']],
		]);
		expect(result[2].bundle?.bundle.items).toEqual([a.item]);
	});
	it('filters items without transferring shared ownership and removes empty bands', () => {
		const a = item('a');
		const b = item('b', 'nameplate');
		expect(
			buildShopCollections([a, b], [bundle('first', [a, b]), bundle('second', [a])], 'nameplate').map((group) => [
				group.id,
				group.entries.map((entry) => entry.sku),
			]),
		).toEqual([['bundle:first', ['cosmetic:b']]]);
	});
	it('never promotes bundle-only or hidden items into individual cards', () => {
		const visible = item('visible');
		const hidden = item('hidden');
		expect(
			buildShopCollections([visible], [bundle('first', [hidden])], 'all').map((group) =>
				group.entries.map((entry) => entry.sku),
			),
		).toEqual([['cosmetic:visible'], ['bundle:first']]);
	});
	it('puts displayed ultras first while preserving bundle and item order within each group', () => {
		const plate = item('plate', 'nameplate');
		const decoration = item('decoration', 'avatar_decoration');
		const ultraA = item('ultra-a');
		const ultraB = item('ultra-b');
		const effect = item('effect', 'profile_effect');
		const standalonePlate = item('standalone-plate', 'nameplate');
		const standaloneUltra = item('standalone-ultra');
		const first = bundle('regular-first', [plate]);
		const mixed = bundle('mixed', [decoration, ultraB, effect, ultraA]);
		const last = bundle('regular-last', [effect]);
		const items = [plate, decoration, ultraA, ultraB, effect, standalonePlate, standaloneUltra];
		const bundles = [first, mixed, last];
		expect(
			buildShopCollections(items, bundles, 'all').map((group) => [group.id, group.entries.map((entry) => entry.sku)]),
		).toEqual([
			[
				'bundle:mixed',
				['bundle:mixed', 'cosmetic:ultra-b', 'cosmetic:ultra-a', 'cosmetic:decoration', 'cosmetic:effect'],
			],
			['other', ['cosmetic:standalone-ultra', 'cosmetic:standalone-plate']],
			['bundle:regular-first', ['bundle:regular-first', 'cosmetic:plate']],
			['bundle:regular-last', ['bundle:regular-last']],
		]);
		expect(items.map((entry) => entry.sku)).toEqual([
			'cosmetic:plate',
			'cosmetic:decoration',
			'cosmetic:ultra-a',
			'cosmetic:ultra-b',
			'cosmetic:effect',
			'cosmetic:standalone-plate',
			'cosmetic:standalone-ultra',
		]);
		expect(bundles).toEqual([first, mixed, last]);
		expect(mixed.bundle.items).toEqual([decoration.item, ultraB.item, effect.item, ultraA.item]);
	});
	it('does not promote collections for ultras excluded by the filter or already assigned to another bundle', () => {
		const plate = item('plate', 'nameplate');
		const ultra = item('ultra');
		const effect = item('effect', 'profile_effect');
		const bundles = [bundle('regular', [plate]), bundle('ultra', [ultra]), bundle('shared', [ultra, effect])];
		expect(buildShopCollections([plate, ultra, effect], bundles, 'all').map((group) => group.id)).toEqual([
			'bundle:ultra',
			'bundle:regular',
			'bundle:shared',
		]);
		expect(buildShopCollections([plate, ultra, effect], bundles, 'nameplate').map((group) => group.id)).toEqual([
			'bundle:regular',
		]);
	});
	it('keeps standalone items in catalog order and emits no empty fallback', () => {
		expect(buildShopCollections([item('b'), item('a')], [], 'all')[0].entries.map((entry) => entry.sku)).toEqual([
			'cosmetic:b',
			'cosmetic:a',
		]);
		expect(buildShopCollections([], [], 'all')).toEqual([]);
	});
});
