// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getVisionaryService} from '@app/api/middleware/ServiceSingletons';
import {slotRows} from '@app/api/premium/visionary/tests/VisionaryTestUtils';
import {VISIONARY_OVER_CAP_KEY} from '@app/api/premium/visionary/VisionaryService';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {ShopAdminVisionaryResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('admin Visionary slots', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});
	beforeEach(async () => {
		await harness.reset();
	});
	afterAll(async () => {
		await harness?.shutdown();
	});

	async function admin(acls: Array<string> = [AdminACLs.SHOP_MANAGE]): Promise<TestAccount> {
		return setUserACLs(harness, await createTestAccount(harness), [AdminACLs.AUTHENTICATE, ...acls]);
	}

	function getSlots(account: TestAccount, status: number = HTTP_STATUS.OK) {
		return createBuilder<ShopAdminVisionaryResponse>(harness, account.token)
			.get('/admin/shop/visionary')
			.expect(status)
			.execute();
	}

	function setSlots(account: TestAccount, total: number, status: number = HTTP_STATUS.OK, code?: string) {
		return createBuilder<ShopAdminVisionaryResponse>(harness, account.token)
			.put('/admin/shop/visionary/slots')
			.body({total})
			.expect(status, code)
			.execute();
	}

	it('needs SHOP_MANAGE', async () => {
		const cosmeticsAdmin = await admin([AdminACLs.COSMETICS_MANAGE]);

		await getSlots(cosmeticsAdmin, HTTP_STATUS.FORBIDDEN);
		await setSlots(cosmeticsAdmin, 3, HTTP_STATUS.FORBIDDEN);

		expect(await slotRows()).toEqual([]);
	});

	it('grows and shows total, sold, held, remaining and over-cap grants', async () => {
		const shopAdmin = await admin();

		expect(await setSlots(shopAdmin, 3)).toEqual({total: 3, sold: 0, held: 0, remaining: 3, over_cap_grants: 0});
		const buyer = createUserID(BigInt((await createTestAccount(harness)).userId));
		await getVisionaryService().holdForOrder(buyer, 1n);
		await getVisionaryService().holdForOrder(buyer, 2n);
		await getVisionaryService().deliverForOrder(buyer, 2n);
		await getKVClient().incr(VISIONARY_OVER_CAP_KEY);

		expect(await getSlots(shopAdmin)).toEqual({total: 3, sold: 1, held: 1, remaining: 1, over_cap_grants: 1});
	});

	it('refuses to shrink below an owned or held slot with CANNOT_SHRINK_RESERVED_SLOTS', async () => {
		const shopAdmin = await admin();
		await setSlots(shopAdmin, 3);
		const buyer = createUserID(BigInt((await createTestAccount(harness)).userId));
		await getVisionaryService().holdForOrder(buyer, 1n);
		await getVisionaryService().holdForOrder(buyer, 2n);
		await getVisionaryService().deliverForOrder(buyer, 2n);

		await setSlots(shopAdmin, 1, HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CANNOT_SHRINK_RESERVED_SLOTS);
		await setSlots(shopAdmin, 0, HTTP_STATUS.BAD_REQUEST, APIErrorCodes.CANNOT_SHRINK_RESERVED_SLOTS);

		expect((await slotRows()).map((row) => row.slot_index)).toEqual([1, 2, 3]);
		expect(await getSlots(shopAdmin)).toMatchObject({total: 3, sold: 1, held: 1});
	});

	it('shrinks free slots from the top', async () => {
		const shopAdmin = await admin();
		await setSlots(shopAdmin, 5);
		await getVisionaryService().holdForOrder(createUserID(1n), 1n);

		expect(await setSlots(shopAdmin, 2)).toEqual({total: 2, sold: 0, held: 1, remaining: 1, over_cap_grants: 0});

		expect((await slotRows()).map((row) => [row.slot_index, row.order_id ?? null])).toEqual([
			[1, 1n],
			[2, null],
		]);
	});
});
