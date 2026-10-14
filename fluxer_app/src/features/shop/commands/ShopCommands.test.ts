// SPDX-License-Identifier: AGPL-3.0-or-later

import {beforeEach, describe, expect, it, vi} from 'vitest';

const http = vi.hoisted(() => ({get: vi.fn(), post: vi.fn()}));

vi.mock('@app/features/platform/transport/RestTransport', () => ({http}));

const ShopCommands = await import('@app/features/shop/commands/ShopCommands');

describe('ShopCommands', () => {
	beforeEach(() => {
		http.get.mockReset().mockResolvedValue({body: {read: true}});
		http.post.mockReset().mockResolvedValue({body: {id: '1'}});
	});

	it('createOrder sends the sku and nothing else', async () => {
		await expect(ShopCommands.createOrder('premium:3')).resolves.toEqual({id: '1'});
		expect(http.post).toHaveBeenCalledTimes(1);
		expect(http.post).toHaveBeenCalledWith('/shop/orders', {body: {sku: 'premium:3'}});
	});

	it.each([
		['the catalog', () => ShopCommands.fetchCatalog(), ['/shop/catalog']],
		['a quote', () => ShopCommands.fetchQuote('cosmetic:5'), ['/shop/quote', {query: {sku: 'cosmetic:5'}}]],
		['an order', () => ShopCommands.fetchOrder('123'), ['/shop/orders/123']],
		['a code', () => ShopCommands.fetchCode('Ab3dEf9h'), ['/shop/codes/Ab3dEf9h']],
	] as const)('reads %s', async (_case, read, call) => {
		await expect(read()).resolves.toEqual({read: true});
		expect(http.get).toHaveBeenCalledWith(...call);
		expect(http.post).not.toHaveBeenCalled();
	});
});
