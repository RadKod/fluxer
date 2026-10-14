// SPDX-License-Identifier: AGPL-3.0-or-later

import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ShopBusyError} from '@fluxer/errors/src/domains/payment/ShopBusyError';
import {ShopItemUnavailableError} from '@fluxer/errors/src/domains/payment/ShopItemUnavailableError';
import {ShopSalesClosedError} from '@fluxer/errors/src/domains/payment/ShopSalesClosedError';
import {ShopTooManyOpenOrdersError} from '@fluxer/errors/src/domains/payment/ShopTooManyOpenOrdersError';
import {CosmeticAlreadyOwnedError} from '@fluxer/errors/src/domains/user/CosmeticAlreadyOwnedError';
import {describe, expect, it} from 'vitest';

describe('shop errors', () => {
	it.each([
		[new ShopSalesClosedError(), APIErrorCodes.SHOP_SALES_CLOSED, 403],
		[new ShopItemUnavailableError(), APIErrorCodes.SHOP_ITEM_UNAVAILABLE, 404],
		[new ShopTooManyOpenOrdersError(), APIErrorCodes.SHOP_TOO_MANY_OPEN_ORDERS, 409],
		[new ShopBusyError(), APIErrorCodes.SHOP_BUSY, 503],
		[new CosmeticAlreadyOwnedError(), APIErrorCodes.COSMETIC_ALREADY_OWNED, 409],
	])('%s carries its code and status', (error, code, status) => {
		expect(error.code).toBe(code);
		expect(error.status).toBe(status);
	});
});
