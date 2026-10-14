// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createCosmeticItem} from '@app/api/admin/tests/audit_coverage/CosmeticAdminAuditCases';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';
import {expect} from 'vitest';

async function adminWrite(harness: ApiTestHarness, token: string, method: string, path: string, body: unknown) {
	const response = await harness.requestJson({path, method, body, headers: {Authorization: token}});
	if (response.status !== 200) {
		throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
	}
	await response.arrayBuffer();
}

function putPrice(harness: ApiTestHarness, token: string, sku: string, baseUsdCents: number): Promise<void> {
	return adminWrite(harness, token, 'PUT', '/admin/shop/prices', {prices: [{sku, base_usd_cents: baseUsdCents}]});
}

async function ownedItems(harness: ApiTestHarness, token: string): Promise<[string, string]> {
	return [await createCosmeticItem(harness, token, 'owned'), await createCosmeticItem(harness, token, 'owned')];
}

async function createBundle(harness: ApiTestHarness, token: string, itemIds: ReadonlyArray<string>): Promise<string> {
	const response = await harness.requestJson({
		path: '/admin/shop/bundles',
		method: 'POST',
		body: {name: 'Coverage bundle', item_ids: itemIds},
		headers: {Authorization: token},
	});
	if (response.status !== 200) {
		throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
	}
	return ((await response.json()) as {id: string}).id;
}

export const ShopAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'GET',
		route: '/admin/shop',
		async prepare() {
			return {
				request: {path: '/admin/shop'},
				expected: {action: 'view_shop', targetType: 'shop', targetId: '0', metadata: {result_count: '0'}},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/shop/settings',
		async prepare() {
			return {
				request: {path: '/admin/shop/settings', body: {premium_discount_percent: 30}},
				expected: {
					action: 'update_shop_settings',
					targetType: 'shop',
					targetId: '0',
					metadata: {premium_discount_percent_old: '0', premium_discount_percent_new: '30'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/shop/settings/refresh-try-rate',
		async prepare() {
			return {
				request: {path: '/admin/shop/settings/refresh-try-rate', expectStatus: 204},
				expected: {action: 'refresh_shop_try_rate', targetType: 'shop', targetId: '0', metadata: {}},
			};
		},
	},
	{
		method: 'PUT',
		route: '/admin/shop/prices',
		async prepare() {
			return {
				request: {path: '/admin/shop/prices', body: {prices: [{sku: 'premium:1', base_usd_cents: 500}]}},
				expected: {
					action: 'set_shop_prices',
					targetType: 'shop',
					targetId: '0',
					metadata: {count: '1', skus: 'premium:1', changes: 'premium:1:none→500'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/shop/campaigns',
		async prepare({harness, admin}) {
			await putPrice(harness, admin.token, 'premium:1', 500);
			return {
				request: {path: '/admin/shop/campaigns', body: {skus: ['premium:1'], percent: 20, ends_at: null}},
				expected: {
					action: 'apply_shop_campaign',
					targetType: 'shop',
					targetId: '0',
					metadata: {count: '1', percent: '20', changes: 'premium:1:none→20%'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/shop/campaigns/remove',
		async prepare({harness, admin}) {
			await putPrice(harness, admin.token, 'premium:1', 500);
			await adminWrite(harness, admin.token, 'POST', '/admin/shop/campaigns', {
				skus: ['premium:1'],
				percent: 20,
				ends_at: '2099-01-01T00:00:00.000Z',
			});
			return {
				request: {path: '/admin/shop/campaigns/remove', body: {skus: ['premium:1']}},
				expected: {
					action: 'remove_shop_campaign',
					targetType: 'shop',
					targetId: '0',
					metadata: {count: '1', changes: 'premium:1:20%@2099-01-01T00:00:00.000Z→none'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/shop/bundles',
		async prepare({harness, admin}) {
			const itemIds = await ownedItems(harness, admin.token);
			return {
				request: {path: '/admin/shop/bundles', body: {name: 'Coverage bundle', item_ids: itemIds}},
				expected: {
					action: 'create_shop_bundle',
					targetType: 'shop_bundle',
					targetId: expect.any(String),
					metadata: {name: 'Coverage bundle', item_ids: itemIds.join(',')},
				},
			};
		},
	},
	{
		method: 'PATCH',
		route: '/admin/shop/bundles/:bundle_id',
		async prepare({harness, admin}) {
			const bundleId = await createBundle(harness, admin.token, await ownedItems(harness, admin.token));
			return {
				request: {path: `/admin/shop/bundles/${bundleId}`, body: {name: 'Renamed bundle'}},
				expected: {
					action: 'update_shop_bundle',
					targetType: 'shop_bundle',
					targetId: bundleId,
					metadata: {name_old: 'Coverage bundle', name_new: 'Renamed bundle'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/shop/bundles/:bundle_id',
		async prepare({harness, admin}) {
			const bundleId = await createBundle(harness, admin.token, await ownedItems(harness, admin.token));
			return {
				request: {path: `/admin/shop/bundles/${bundleId}`, expectStatus: 204},
				expected: {
					action: 'delete_shop_bundle',
					targetType: 'shop_bundle',
					targetId: bundleId,
					metadata: {name: 'Coverage bundle'},
				},
			};
		},
	},
];
