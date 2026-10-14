// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import type {ShopOrderRow} from '@app/api/database/types/ShopTypes';
import {ShopOrderRepository, shopOrderCheckShard, shopOrderCheckSlot} from '@app/api/shop/ShopOrderRepository';
import {describe, expect, it} from 'vitest';

const USER = createUserID(1490000000000000100n);
const CREATED_AT = new Date('2026-09-28T10:00:00Z');
const FIRST_CHECK = new Date('2026-09-28T10:02:00Z');

function orderRow(overrides: Partial<ShopOrderRow> = {}): ShopOrderRow {
	return {
		order_id: 1490000000000000001n,
		user_id: USER,
		sku: 'cosmetic:1490000000000000200',
		item_id: 1490000000000000200n,
		item_ids: null,
		premium_months: null,
		base_usd_cents: 500,
		campaign_percent: 20,
		premium_percent: 30,
		final_usd_cents: 280,
		rate_micro: 1_700_000,
		amount_minor: 476,
		display_currency: null,
		display_amount_minor: null,
		display_rate_micro: null,
		currency: 'AZN',
		status: 'pending',
		failure_reason: null,
		provider: 'payriff',
		provider_order_id: null,
		provider_status: null,
		payment_url: null,
		callback_token_hash: 'a'.repeat(64),
		check_count: 0,
		next_check_at: FIRST_CHECK,
		created_at: CREATED_AT,
		updated_at: CREATED_AT,
		paid_at: null,
		granted_at: null,
		version: 1,
		...overrides,
	};
}

describe('ShopOrderRepository', () => {
	const repository = new ShopOrderRepository();

	it('creates an order once', async () => {
		const row = orderRow();

		expect(await repository.create(row)).toBe(true);
		expect(await repository.create({...row, amount_minor: 1})).toBe(false);
		expect(await repository.find(row.order_id)).toEqual(row);
		expect(await repository.listForUser(USER, 10)).toEqual([
			{user_id: USER, order_id: row.order_id, sku: row.sku, created_at: CREATED_AT},
		]);
		expect(await repository.listChecks(shopOrderCheckSlot(FIRST_CHECK), shopOrderCheckShard(row.order_id), 10)).toEqual(
			[
				{
					slot: shopOrderCheckSlot(FIRST_CHECK),
					shard: shopOrderCheckShard(row.order_id),
					order_id: row.order_id,
					due_at: FIRST_CHECK,
				},
			],
		);
		expect(await repository.find(2n)).toBeNull();
	});

	it('refuses a patch with a stale version', async () => {
		const row = orderRow();
		await repository.create(row);

		expect(await repository.patch(row.order_id, {status: 'failed', failure_reason: 'provider_error'}, 2)).toBe(false);
		expect(await repository.patch(row.order_id, {provider_order_id: 'p-1', payment_url: 'https://pay/1'}, 1)).toBe(
			true,
		);
		expect(await repository.patch(row.order_id, {status: 'paid'}, 1)).toBe(false);
		expect(await repository.patch(row.order_id, {status: 'paid', next_check_at: null}, 2)).toBe(true);

		const stored = await repository.find(row.order_id);
		expect(stored).toMatchObject({
			status: 'paid',
			provider_order_id: 'p-1',
			payment_url: 'https://pay/1',
			next_check_at: null,
			failure_reason: null,
			version: 3,
		});
		expect(stored!.updated_at.getTime()).toBeGreaterThan(CREATED_AT.getTime());
	});

	it("lists a user's orders newest first and pages with before", async () => {
		for (const id of [11n, 13n, 12n]) {
			await repository.create(orderRow({order_id: id, next_check_at: null}));
		}
		await repository.create(orderRow({order_id: 14n, user_id: createUserID(7n), next_check_at: null}));

		expect((await repository.listForUser(USER, 10)).map((row) => row.order_id)).toEqual([13n, 12n, 11n]);
		expect((await repository.listForUser(USER, 2)).map((row) => row.order_id)).toEqual([13n, 12n]);
		expect((await repository.listForUser(USER, 2, 12n)).map((row) => row.order_id)).toEqual([11n]);
	});

	it('schedules, lists and deletes checks by slot and shard', async () => {
		const due = new Date('2026-09-28T13:00:00Z');
		const slot = shopOrderCheckSlot(due);
		expect(slot).toBe(Math.floor(due.getTime() / 300_000));
		expect(shopOrderCheckShard(33n)).toBe(1);
		for (const orderId of [17n, 33n, 49n, 34n]) {
			await repository.scheduleCheck({slot, shard: shopOrderCheckShard(orderId), order_id: orderId, due_at: due});
		}

		expect((await repository.listChecks(slot, 1, 10)).map((row) => row.order_id)).toEqual([17n, 33n, 49n]);
		expect((await repository.listChecks(slot, 1, 2)).map((row) => row.order_id)).toEqual([17n, 33n]);
		expect((await repository.listChecks(slot, 1, 10, 33n)).map((row) => row.order_id)).toEqual([49n]);
		expect((await repository.listChecks(slot, 2, 10)).map((row) => row.order_id)).toEqual([34n]);
		expect(await repository.listChecks(slot + 1, 1, 10)).toEqual([]);

		await repository.deleteCheck({slot, shard: 1, order_id: 33n});
		expect((await repository.listChecks(slot, 1, 10)).map((row) => row.order_id)).toEqual([17n, 49n]);

		await repository.deletePendingCheck({order_id: 49n, next_check_at: due});
		await repository.deletePendingCheck({order_id: 17n, next_check_at: null});
		expect((await repository.listChecks(slot, 1, 10)).map((row) => row.order_id)).toEqual([17n]);
	});
});
