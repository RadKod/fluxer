// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {getVisionarySlotRepository} from '@app/api/middleware/ServiceSingletons';
import type {ApiTestHarness} from '@app/api/test/ApiTestHarness';

async function adminRequest(
	harness: ApiTestHarness,
	token: string,
	method: 'POST' | 'PUT',
	path: string,
	body: unknown,
): Promise<void> {
	const response = await harness.requestJson({path, method, body, headers: {Authorization: token}});
	if (response.status !== 200) {
		throw new Error(`Expected 200, got ${response.status}: ${await response.text()}`);
	}
	await response.arrayBuffer();
}

// Stripe test mode opens 100 upstream test slots at startup (VisionarySlotInitializer); a Micup instance starts with
// none, so each case starts from an empty table.
function clearVisionarySlots(): Promise<void> {
	return getVisionarySlotRepository().shrinkVisionarySlots(0);
}

function putVisionarySlots(harness: ApiTestHarness, token: string, total: number): Promise<void> {
	return adminRequest(harness, token, 'PUT', '/admin/shop/visionary/slots', {total});
}

function grantVisionary(harness: ApiTestHarness, token: string, userId: string): Promise<void> {
	return adminRequest(harness, token, 'POST', `/admin/users/${userId}/visionary`, {});
}

export const VisionaryAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'GET',
		route: '/admin/shop/visionary',
		async prepare() {
			await clearVisionarySlots();
			return {
				request: {path: '/admin/shop/visionary'},
				expected: {action: 'view_shop_visionary', targetType: 'shop', targetId: '0', metadata: {total: '0'}},
			};
		},
	},
	{
		method: 'PUT',
		route: '/admin/shop/visionary/slots',
		async prepare() {
			await clearVisionarySlots();
			return {
				request: {path: '/admin/shop/visionary/slots', body: {total: 3}},
				expected: {
					action: 'set_visionary_slots',
					targetType: 'shop',
					targetId: '0',
					metadata: {total_old: '0', total_new: '3'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/users/:user_id/visionary',
		async prepare({harness, admin}) {
			await clearVisionarySlots();
			await putVisionarySlots(harness, admin.token, 3);
			const user = await createTestAccount(harness);
			return {
				request: {path: `/admin/users/${user.userId}/visionary`, body: {}},
				expected: {
					action: 'grant_visionary',
					targetType: 'user',
					targetId: user.userId,
					metadata: {slot: '1', changed: 'true', reward_count: '0'},
				},
			};
		},
	},
	{
		method: 'DELETE',
		route: '/admin/users/:user_id/visionary',
		async prepare({harness, admin}) {
			await clearVisionarySlots();
			await putVisionarySlots(harness, admin.token, 3);
			const user = await createTestAccount(harness);
			await grantVisionary(harness, admin.token, user.userId);
			return {
				request: {path: `/admin/users/${user.userId}/visionary`},
				expected: {
					action: 'revoke_visionary',
					targetType: 'user',
					targetId: user.userId,
					metadata: {slot: '1', changed: 'true', rewards_taken_back: '0'},
				},
			};
		},
	},
];
