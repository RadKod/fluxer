// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('cosmetic items by ID', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	let user: TestAccount;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.COSMETICS_MANAGE,
		]);
		user = await createTestAccount(harness);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function createItem(body: Record<string, unknown>): Promise<CosmeticItemResponse> {
		return createBuilder<CosmeticItemResponse>(harness, admin.token)
			.post('/admin/cosmetics/items')
			.body({asset: PNG, ...body})
			.expect(200)
			.execute();
	}

	function readItems(ids: string) {
		return createBuilder<Array<CosmeticItemResponse>>(harness, user.token).get(`/cosmetics/items?ids=${ids}`);
	}

	it('reads by ID, off-sale items included, without listing the table', async () => {
		const onSale = await createItem({type: 'avatar_ultra', name: 'Yitik Melek', availability: 'free'});
		const retired = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'premium'});
		await createBuilder(harness, admin.token).delete(`/admin/cosmetics/items/${retired.id}`).expect(204).execute();
		const listAll = vi.spyOn(CosmeticRepository.prototype, 'listAllItems');
		const listCatalog = vi.spyOn(CosmeticRepository.prototype, 'listCatalog');

		const items = await readItems(`${retired.id},${onSale.id},${retired.id}`).expect(200).execute();

		expect(items).toEqual([{...retired, availability: 'owned'}, onSale]);
		expect(listAll).not.toHaveBeenCalled();
		expect(listCatalog).not.toHaveBeenCalled();
	});

	it('omits unknown IDs', async () => {
		const item = await createItem({type: 'nameplate', name: 'Plate', availability: 'free'});

		expect(await readItems(`123,${item.id}`).expect(200).execute()).toEqual([item]);
		expect(await readItems('123').expect(200).execute()).toEqual([]);
	});

	it('refuses 51 IDs and an ID above int64', async () => {
		const tooMany = Array.from({length: 51}, (_, index) => String(index + 1)).join(',');
		await readItems(tooMany).expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();
		await readItems('9223372036854775808').expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();
		await readItems('').expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();
	});

	it('a second read within a minute hits the process cache', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
		const getItem = vi.spyOn(CosmeticRepository.prototype, 'getItem');

		await readItems(item.id).expect(200).execute();
		expect(await readItems(item.id).expect(200).execute()).toEqual([item]);

		expect(getItem).toHaveBeenCalledTimes(1);
	});

	it('shows an admin change right away in the process that made it', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
		await readItems(item.id).expect(200).execute();

		await createBuilder(harness, admin.token)
			.patch(`/admin/cosmetics/items/${item.id}`)
			.body({name: 'Kara Kuzgun'})
			.expect(200)
			.execute();

		expect((await readItems(item.id).expect(200).execute())[0]?.name).toBe('Kara Kuzgun');
	});
});
