// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {expect} from 'vitest';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export async function createCosmeticItem(
	harness: ApiTestHarness,
	token: string,
	availability: 'free' | 'owned' = 'free',
): Promise<string> {
	const response = await harness.requestJson({
		path: '/admin/cosmetics/items',
		method: 'POST',
		body: {type: 'nameplate', name: 'Coverage plate', availability, asset: PNG},
		headers: {Authorization: token},
	});
	if (response.status !== 200) {
		throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
	}
	return ((await response.json()) as {id: string}).id;
}

async function grantCosmeticItem(harness: ApiTestHarness, token: string, userId: string, itemId: string) {
	const response = await harness.requestJson({
		path: `/admin/users/${userId}/cosmetics/${itemId}`,
		method: 'POST',
		headers: {Authorization: token},
	});
	if (response.status !== 200) {
		throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
	}
	await response.arrayBuffer();
}

export const CosmeticAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'GET',
		route: '/admin/cosmetics/items',
		async prepare({harness, admin}) {
			await createCosmeticItem(harness, admin.token);
			return {
				request: {path: '/admin/cosmetics/items'},
				expected: {
					action: 'list_cosmetic_items',
					targetType: 'cosmetic_item',
					targetId: '0',
					metadata: {result_count: '1'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/cosmetics/items',
		async prepare() {
			return {
				request: {
					path: '/admin/cosmetics/items',
					body: {type: 'avatar_decoration', name: 'Coverage ring', availability: 'premium', asset: PNG},
				},
				expected: {
					action: 'create_cosmetic_item',
					targetType: 'cosmetic_item',
					targetId: expect.any(String),
					metadata: {type: 'avatar_decoration', availability: 'premium'},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/cosmetics/items/:item_id',
		async prepare({harness, admin}) {
			const itemId = await createCosmeticItem(harness, admin.token);
			return {
				request: {path: `/admin/cosmetics/items/${itemId}`, body: {name: 'Renamed plate', availability: 'owned'}},
				expected: {
					action: 'update_cosmetic_item',
					targetType: 'cosmetic_item',
					targetId: itemId,
					metadata: {fields: 'name,availability', availability: 'owned'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/cosmetics/items/:item_id',
		async prepare({harness, admin}) {
			const itemId = await createCosmeticItem(harness, admin.token);
			return {
				request: {path: `/admin/cosmetics/items/${itemId}`, expectStatus: 204},
				expected: {
					action: 'retire_cosmetic_item',
					targetType: 'cosmetic_item',
					targetId: itemId,
					metadata: {},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/users/:user_id/cosmetics/:item_id',
		async prepare({harness, admin}) {
			const itemId = await createCosmeticItem(harness, admin.token, 'owned');
			const user = await createTestAccount(harness);
			return {
				request: {path: `/admin/users/${user.userId}/cosmetics/${itemId}`},
				expected: {
					action: 'grant_cosmetic_item',
					targetType: 'user',
					targetId: user.userId,
					metadata: {item_id: itemId, changed: 'true'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/users/:user_id/cosmetics/:item_id',
		async prepare({harness, admin}) {
			const itemId = await createCosmeticItem(harness, admin.token, 'owned');
			const user = await createTestAccount(harness);
			await grantCosmeticItem(harness, admin.token, user.userId, itemId);
			return {
				request: {path: `/admin/users/${user.userId}/cosmetics/${itemId}`},
				expected: {
					action: 'revoke_cosmetic_item',
					targetType: 'user',
					targetId: user.userId,
					metadata: {item_id: itemId, changed: 'true', unequipped: 'false'},
				},
			};
		},
	},
];
