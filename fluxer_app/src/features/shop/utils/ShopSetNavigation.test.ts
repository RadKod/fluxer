// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const router = vi.hoisted(() => ({transitionTo: vi.fn(), replaceWith: vi.fn(), back: vi.fn()}));

vi.mock('@app/app/Routes', () => ({Routes: {SHOP: '/shop'}}));
vi.mock('@app/features/navigation/utils/RouterUtils', () => ({
	transitionTo: router.transitionTo,
	replaceWith: router.replaceWith,
	getHistory: () => ({back: router.back}),
}));

const {leaveShopSet, openShopSet} = await import('@app/features/shop/utils/ShopSetNavigation');

describe('ShopSetNavigation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		leaveShopSet('reset');
		vi.clearAllMocks();
	});

	it('opens a set as a new page of the shop', () => {
		openShopSet('70');
		expect(router.transitionTo).toHaveBeenCalledWith('/shop?set=70');
	});

	it('leaving a set opened from the shop goes back, adding no history entry', () => {
		openShopSet('70');
		leaveShopSet('70');
		expect(router.back).toHaveBeenCalledOnce();
		expect(router.transitionTo).toHaveBeenCalledTimes(1);
		expect(router.replaceWith).not.toHaveBeenCalled();
	});

	it('leaving a set opened from a link replaces it with the shop, so Back does not reopen it', () => {
		leaveShopSet('70');
		expect(router.back).not.toHaveBeenCalled();
		expect(router.replaceWith).toHaveBeenCalledWith('/shop');
	});

	it('only the set opened from the shop goes back; another set left later replaces', () => {
		openShopSet('70');
		leaveShopSet('71');
		expect(router.replaceWith).toHaveBeenCalledWith('/shop');
		leaveShopSet('70');
		expect(router.back).not.toHaveBeenCalled();
	});
});
