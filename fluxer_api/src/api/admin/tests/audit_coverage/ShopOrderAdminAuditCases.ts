// SPDX-License-Identifier: AGPL-3.0-or-later

import type {AdminAuditCoverageCase} from '@app/api/admin/tests/audit_coverage/AdminAuditCoverage';
import {createUserID} from '@app/api/BrandedTypes';
import {getShopOrderRepository} from '@app/api/middleware/ServiceSingletons';
import {createCallbackToken} from '@app/api/payriff/PayriffCallbackToken';

const ORDER_ID = 1490000000000000001n;

export const ShopOrderAdminAuditCases: ReadonlyArray<AdminAuditCoverageCase> = [
	{
		method: 'GET',
		route: '/admin/shop/orders/:order_id',
		async prepare() {
			const created = new Date();
			await getShopOrderRepository().create({
				order_id: ORDER_ID,
				user_id: createUserID(1490000000000000100n),
				sku: 'premium:1',
				item_id: null,
				item_ids: null,
				premium_months: 1,
				base_usd_cents: 500,
				campaign_percent: 0,
				premium_percent: 0,
				final_usd_cents: 500,
				rate_micro: 1_700_000,
				amount_minor: 850,
				display_currency: null,
				display_amount_minor: null,
				display_rate_micro: null,
				currency: 'AZN',
				status: 'pending',
				failure_reason: null,
				provider: 'payriff',
				provider_order_id: 'payriff-order-1',
				provider_status: null,
				payment_url: 'https://pay.payriff.test/r/payriff-order-1?type=direct',
				callback_token_hash: createCallbackToken().hash,
				check_count: 0,
				next_check_at: null,
				created_at: created,
				updated_at: created,
				paid_at: null,
				granted_at: null,
				version: 1,
			});
			return {
				request: {path: `/admin/shop/orders/${ORDER_ID}`},
				expected: {
					action: 'view_shop_order',
					targetType: 'shop_order',
					targetId: ORDER_ID.toString(),
					metadata: {order_id: ORDER_ID.toString()},
				},
			};
		},
	},
];
