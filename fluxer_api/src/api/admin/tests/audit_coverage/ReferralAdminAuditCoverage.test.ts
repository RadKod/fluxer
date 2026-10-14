// SPDX-License-Identifier: AGPL-3.0-or-later

import {describeAdminAuditCoverage} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {ReferralAdminAuditCases} from '@app/api/admin/tests/audit_coverage/ReferralAdminAuditCases';
import {createTestAccount, setUserACLs} from '@app/api/auth/tests/AuthTestUtils';
import {createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {describe, expect, test} from 'vitest';

describeAdminAuditCoverage('ReferralAdminController', ReferralAdminAuditCases);

describe('Referral admin routes without referral:manage', () => {
	test('every route answers 403', async () => {
		const harness = await createApiTestHarness();
		try {
			const admin = await setUserACLs(harness, await createTestAccount(harness), [AdminACLs.SHOP_MANAGE]);
			const statuses: Array<string> = [];
			for (const {method, route} of ReferralAdminAuditCases) {
				const response = await harness.requestJson({
					path: route.replace(/:[a-z_]+/g, '1'),
					method,
					body: method === 'GET' ? undefined : {},
					headers: {Authorization: admin.token},
				});
				await response.arrayBuffer();
				statuses.push(`${method} ${route} ${response.status}`);
			}
			expect(statuses).toEqual(ReferralAdminAuditCases.map(({method, route}) => `${method} ${route} 403`));
		} finally {
			await harness.shutdown();
		}
	});
});
