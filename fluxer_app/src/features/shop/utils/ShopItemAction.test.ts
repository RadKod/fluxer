// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ShopBundleEntry} from '@app/features/shop/utils/ShopEntries';
import type {ShopItemActionInput} from '@app/features/shop/utils/ShopItemAction';
import {resolveShopBundleAction, resolveShopItemAction} from '@app/features/shop/utils/ShopItemAction';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {describe, expect, it, vi} from 'vitest';

// The table itself reads no store; the real one loads the app runtime.
vi.mock('@app/features/cosmetics/state/Cosmetics', () => ({default: {}}));

const PRICE = {
	base_try_minor: 500,
	campaign_percent: null,
	campaign_ends_at: null,
	sale_try_minor: 500,
	premium_try_minor: 350,
};

function input(availability: CosmeticItemResponse['availability'], extra: Partial<ShopItemActionInput> = {}) {
	const item: CosmeticItemResponse = {
		id: '11',
		type: 'avatar_ultra',
		name: 'Yitik Melek',
		description: null,
		asset: 'hash',
		availability,
	};
	return {
		entry: {kind: 'item', sku: 'cosmetic:11', item, price: availability === 'owned' ? PRICE : null},
		owned: false,
		equipped: false,
		isPremium: false,
		itemSalesOpen: true,
		premiumSalesOpen: true,
		purchaseBlock: null,
		...extra,
	} satisfies ShopItemActionInput;
}

// One case per row of the shop action table.
describe('resolveShopItemAction', () => {
	it('offers to buy a priced item the account does not have while item sales are open', () => {
		expect(resolveShopItemAction(input('owned'))).toEqual({kind: 'buy'});
	});

	it('offers to equip an item the account has but does not wear', () => {
		expect(resolveShopItemAction(input('owned', {owned: true}))).toEqual({kind: 'equip'});
	});

	it('shows an item the account wears as equipped', () => {
		expect(resolveShopItemAction(input('owned', {owned: true, equipped: true}))).toEqual({kind: 'equipped'});
	});

	it('lets a premium member equip a premium item, and shows it as equipped once worn', () => {
		expect(resolveShopItemAction(input('premium', {isPremium: true}))).toEqual({kind: 'equip'});
		expect(resolveShopItemAction(input('premium', {isPremium: true, equipped: true}))).toEqual({kind: 'equipped'});
	});

	it('offers premium for a premium item to an account without premium while premium sales are open', () => {
		expect(resolveShopItemAction(input('premium'))).toEqual({kind: 'get_premium'});
	});

	it('offers nothing for a premium item while premium sales are closed', () => {
		expect(resolveShopItemAction(input('premium', {premiumSalesOpen: false}))).toEqual({kind: 'none', label: null});
	});

	it('says a priced item is not on sale while item sales are closed', () => {
		expect(resolveShopItemAction(input('owned', {itemSalesOpen: false}))).toEqual({
			kind: 'none',
			label: 'not_on_sale',
		});
	});

	it.each(['unclaimed', 'unverified'] as const)('shows a disabled buy button to an %s account', (purchaseBlock) => {
		expect(resolveShopItemAction(input('owned', {purchaseBlock}))).toEqual({
			kind: 'buy_disabled',
			reason: purchaseBlock,
		});
	});
});

describe('resolveShopBundleAction', () => {
	const item = (id: string): CosmeticItemResponse => ({
		id,
		type: 'avatar_decoration',
		name: `item ${id}`,
		description: null,
		asset: `hash${id}`,
		availability: 'owned',
	});
	const entry: ShopBundleEntry = {
		kind: 'bundle',
		sku: 'bundle:70',
		bundle: {
			sku: 'bundle:70',
			id: '70',
			name: 'Gece seti',
			description: null,
			items: [item('1'), item('2')],
			price: PRICE,
		},
		price: PRICE,
	};
	const bundleInput = (extra: Partial<Parameters<typeof resolveShopBundleAction>[0]> = {}) => ({
		entry,
		ownedCount: 0,
		itemSalesOpen: true,
		purchaseBlock: null,
		...extra,
	});

	it('offers to buy a bundle the account has none of while item sales are open', () => {
		expect(resolveShopBundleAction(bundleInput())).toEqual({kind: 'buy'});
	});

	// a bundle with an item the account has cannot be bought, whatever else holds.
	it('offers nothing once the account has one item or all of them', () => {
		expect(resolveShopBundleAction(bundleInput({ownedCount: 1}))).toEqual({kind: 'none', label: 'partly_owned'});
		expect(resolveShopBundleAction(bundleInput({ownedCount: 2, itemSalesOpen: false}))).toEqual({
			kind: 'none',
			label: 'owned',
		});
	});

	it('says a bundle is not on sale while item sales are closed', () => {
		expect(resolveShopBundleAction(bundleInput({itemSalesOpen: false}))).toEqual({kind: 'none', label: 'not_on_sale'});
	});

	it.each(['unclaimed', 'unverified'] as const)('shows a disabled buy button to an %s account', (purchaseBlock) => {
		expect(resolveShopBundleAction(bundleInput({purchaseBlock}))).toEqual({
			kind: 'buy_disabled',
			reason: purchaseBlock,
		});
	});
});
