// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const LAYOUT = {
	compact: {width: 2.3, height: 2.5, offset_x: 0, offset_y: 0.1},
	voice: null,
	profile: {width: 3.4, height: 3.2, offset_x: -0.25, offset_y: 0},
};

describe('ultra decoration sizes', () => {
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

	function patchLayout(item: CosmeticItemResponse, ultraLayout: unknown) {
		return createBuilder<CosmeticItemResponse>(harness, admin.token)
			.patch(`/admin/cosmetics/items/${item.id}`)
			.body({ultra_layout: ultraLayout});
	}

	async function readEverywhere(item: CosmeticItemResponse) {
		const adminList = await createBuilder<Array<CosmeticItemResponse>>(harness, admin.token)
			.get('/admin/cosmetics/items')
			.expect(200)
			.execute();
		const catalog = await createBuilder<Array<CosmeticItemResponse>>(harness, user.token)
			.get('/cosmetics/catalog?type=avatar_ultra')
			.expect(200)
			.execute();
		const byId = await createBuilder<Array<CosmeticItemResponse>>(harness, user.token)
			.get(`/cosmetics/items?ids=${item.id}`)
			.expect(200)
			.execute();
		return [adminList, catalog, byId].map((list) => list.find((entry) => entry.id === item.id)?.ultra_layout);
	}

	it('stores an ultra layout and answers it in the admin list and the catalog', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Yitik Melek', availability: 'free'});

		const updated = await patchLayout(item, LAYOUT).expect(200).execute();

		expect(updated.ultra_layout).toEqual(LAYOUT);
		expect(await readEverywhere(item)).toEqual([LAYOUT, LAYOUT, LAYOUT]);
	});

	it('keeps the layout when another field changes', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Yitik Melek', availability: 'free'});
		await patchLayout(item, LAYOUT).expect(200).execute();

		const renamed = await createBuilder<CosmeticItemResponse>(harness, admin.token)
			.patch(`/admin/cosmetics/items/${item.id}`)
			.body({name: 'Melek'})
			.expect(200)
			.execute();

		expect(renamed.ultra_layout).toEqual(LAYOUT);
	});

	it('null resets to the fixed sizes', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
		await patchLayout(item, LAYOUT).expect(200).execute();

		const reset = await patchLayout(item, null).expect(200).execute();

		expect(reset.ultra_layout).toBeNull();
		expect(await readEverywhere(item)).toEqual([null, null, null]);
	});

	it('refuses a layout on a frame', async () => {
		const frame = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});
		await patchLayout(frame, LAYOUT).expect(400, APIErrorCodes.INVALID_FORM_BODY).execute();
	});

	it('refuses numbers out of range', async () => {
		const item = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
		const surface = {width: 2.3, height: 2.3, offset_x: 0, offset_y: 0};
		for (const bad of [{width: 6.01}, {height: 0.49}, {offset_x: -3.01}, {offset_y: 3.01}]) {
			await patchLayout(item, {compact: {...surface, ...bad}, voice: null, profile: null})
				.expect(400, APIErrorCodes.INVALID_FORM_BODY)
				.execute();
		}
	});

	it('an ultra item without a layout answers null', async () => {
		const ultra = await createItem({type: 'avatar_ultra', name: 'Kuzgun', availability: 'free'});
		const frame = await createItem({type: 'avatar_decoration', name: 'Ring', availability: 'free'});

		expect(ultra.ultra_layout).toBeNull();
		expect(frame.ultra_layout).toBeNull();
		expect(await readEverywhere(ultra)).toEqual([null, null, null]);
	});
});
