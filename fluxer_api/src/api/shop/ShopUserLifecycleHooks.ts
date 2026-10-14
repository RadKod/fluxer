// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {getShopOrderRepository} from '@app/api/middleware/ServiceSingletons';
import type {ShopOrderRepository} from '@app/api/shop/ShopOrderRepository';
import {registerUserHarvestHook} from '@app/api/user/lifecycle/UserLifecycleHooks';

const EXPORT_PAGE = 100;

// The data export: every order of the account, newest first, without the payment page or the callback token hash.
// It reads the order tables only, so a Payriff misconfiguration never breaks an account's export.
async function harvestUserOrders(
	repository: ShopOrderRepository,
	userId: UserID,
): Promise<{orders: Array<Record<string, string | number | null | Array<string>>>}> {
	const orders: Array<Record<string, string | number | null | Array<string>>> = [];
	let before: bigint | undefined;
	for (;;) {
		const page = await repository.listForUser(userId, EXPORT_PAGE, before);
		const rows = await Promise.all(page.map((entry) => repository.find(entry.order_id)));
		for (const row of rows) {
			if (!row) continue;
			orders.push({
				order_id: row.order_id.toString(),
				sku: row.sku,
				status: row.status,
				failure_reason: row.failure_reason ?? null,
				base_usd_cents: row.base_usd_cents,
				campaign_percent: row.campaign_percent,
				premium_percent: row.premium_percent,
				final_usd_cents: row.final_usd_cents,
				amount_azn_minor: row.amount_minor,
				currency: row.currency,
				provider: row.provider,
				provider_order_id: row.provider_order_id ?? null,
				created_at: row.created_at.toISOString(),
				paid_at: row.paid_at?.toISOString() ?? null,
				granted_at: row.granted_at?.toISOString() ?? null,
				// Bundle orders only: the items frozen when the order opened.
				...(row.item_ids ? {item_ids: row.item_ids.map(String)} : {}),
			});
		}
		if (page.length < EXPORT_PAGE) return {orders};
		before = page[page.length - 1]!.order_id;
	}
}

// Orders are financial records: account deletion keeps them, so there is no deletion hook; the data
// export lists them.
export function registerShopUserLifecycleHooks(): void {
	registerUserHarvestHook('shop', ({userId}) => harvestUserOrders(getShopOrderRepository(), userId));
}
