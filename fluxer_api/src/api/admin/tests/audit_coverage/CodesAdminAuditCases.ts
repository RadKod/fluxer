// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createCosmeticItem} from '@app/api/admin/tests/audit_coverage/CosmeticAdminAuditCases';

export const CodesAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'POST',
		route: '/admin/gift-codes',
		async prepare() {
			return {
				request: {
					path: '/admin/gift-codes',
					body: {count: 2, duration_type: 'months', duration_quantity: 3},
				},
				expected: {
					action: 'generate_gift_codes',
					targetType: 'gift_code',
					targetId: '0',
					metadata: {count: '2', duration_type: 'months', duration_quantity: '3'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/gift-codes/revoke',
		async prepare() {
			return {
				request: {
					path: '/admin/gift-codes/revoke',
					body: {codes: ['Unkn0wnC0deUnkn0wnC0deUnkn0wnC0d']},
				},
				expected: {
					action: 'revoke_gift_codes',
					targetType: 'gift_code',
					targetId: '0',
					metadata: {count: '1', revoked: '0', already_redeemed: '0', not_found: '1'},
				},
			};
		},
	},
	{
		method: 'POST',
		route: '/admin/gift-codes/cosmetic',
		async prepare({harness, admin}) {
			const itemId = await createCosmeticItem(harness, admin.token, 'owned');
			return {
				request: {path: '/admin/gift-codes/cosmetic', body: {count: 2, item_id: itemId}},
				expected: {
					action: 'generate_cosmetic_gift_codes',
					targetType: 'gift_code',
					targetId: '0',
					metadata: {count: '2', item_id: itemId},
				},
			};
		},
	},
];
