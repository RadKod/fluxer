// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
	AdminAuditCoverageCase,
	AdminAuditCoverageContext,
} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createCosmeticItem} from '@app/api/admin/tests/audit_coverage/CosmeticAdminAuditCases';
import {createBuilder} from '@app/api/test/TestRequestBuilder';

async function generateCode({harness, admin}: AdminAuditCoverageContext): Promise<string> {
	const {codes} = await createBuilder<{codes: Array<string>}>(harness, admin.token)
		.post('/admin/gift-codes')
		.body({count: 1, duration_type: 'weeks', duration_quantity: 2})
		.execute();
	return codes[0]!.split('/').pop()!;
}

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
		method: 'DELETE',
		route: '/admin/gift-codes/:code',
		async prepare(context) {
			const code = await generateCode(context);
			return {
				request: {path: `/admin/gift-codes/${code}`, expectStatus: 204},
				expected: {
					action: 'revoke_gift_code',
					targetType: 'gift_code',
					targetId: '0',
					metadata: {code, duration_type: 'weeks', duration_quantity: '2'},
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
