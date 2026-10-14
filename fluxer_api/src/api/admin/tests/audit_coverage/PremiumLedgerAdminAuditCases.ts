// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createUserID} from '@app/api/BrandedTypes';
import {getPremiumLedgerService} from '@app/api/middleware/ServiceSingletons';

export const PremiumLedgerAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'POST',
		route: '/admin/users/:user_id/premium/end',
		async prepare({harness}) {
			const user = await createTestAccount(harness);
			const {paidUntil} = await getPremiumLedgerService().grant({
				userId: createUserID(BigInt(user.userId)),
				grantKey: 'audit-coverage',
				duration: {unit: 'months', quantity: 1},
				source: 'admin',
			});
			return {
				request: {path: `/admin/users/${user.userId}/premium/end`},
				expected: {
					action: 'end_user_premium',
					targetType: 'user',
					targetId: user.userId,
					metadata: {previous_paid_until: paidUntil.toISOString()},
				},
			};
		},
	},
];
