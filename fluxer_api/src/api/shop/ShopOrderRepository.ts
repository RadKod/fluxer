// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchOne,
	fetchPage,
	type PagedQueryResult,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db, type DbOp} from '@app/api/database/CassandraTypes';
import {
	SHOP_ORDER_CHECK_SHARDS,
	SHOP_ORDER_CHECK_SLOT_MS,
	type ShopOrderByUserRow,
	type ShopOrderCheckRow,
	type ShopOrderRow,
} from '@app/api/database/types/ShopTypes';
import {ShopOrderChecks, ShopOrders, ShopOrdersByUser} from '@app/api/shop/ShopTables';
import {BACKGROUND_READ_TIMEOUT_MS} from '@pkgs/cassandra/src/Client';

// Base guarantee only: every check row is deleted once checked or once its order ends.
const CHECK_TTL_SECONDS = 7 * 86_400;
const NO_BEFORE = (1n << 63n) - 1n;
// Order IDs are snowflakes, so 0 sorts before every one of them.
const NO_AFTER = 0n;

const FETCH_ORDER_CQL = ShopOrders.select({where: ShopOrders.where.eq('order_id'), limit: 1});
const SCAN_ORDERS_CQL = ShopOrders.selectCql({columns: ['user_id', 'sku', 'status']});

function userOrdersQuery(limit: number) {
	return ShopOrdersByUser.select({
		where: [ShopOrdersByUser.where.eq('user_id'), ShopOrdersByUser.where.lt('order_id', 'before')],
		orderBy: {col: 'order_id', direction: 'DESC'},
		limit,
	});
}

function checksQuery(limit: number) {
	return ShopOrderChecks.select({
		where: [
			ShopOrderChecks.where.eq('slot'),
			ShopOrderChecks.where.eq('shard'),
			ShopOrderChecks.where.gt('order_id', 'after'),
		],
		limit,
	});
}

export function shopOrderCheckSlot(at: Date): number {
	return Math.floor(at.getTime() / SHOP_ORDER_CHECK_SLOT_MS);
}

export function shopOrderCheckShard(orderId: bigint): number {
	return Number(orderId % BigInt(SHOP_ORDER_CHECK_SHARDS));
}

export type ScannedShopOrder = Pick<ShopOrderRow, 'user_id' | 'sku' | 'status'>;
type ShopOrderPatch = Partial<Omit<ShopOrderRow, 'order_id' | 'user_id' | 'version'>>;

// shop_orders (a financial record, kept after account deletion), its per-user index shop_orders_by_user and the
// reconcile schedule shop_order_checks.
export class ShopOrderRepository {
	// Index first: an index entry without its order is skipped by readers, an order without its index never happens.
	async create(row: ShopOrderRow): Promise<boolean> {
		await upsertOne(
			ShopOrdersByUser.upsertAll({
				user_id: row.user_id,
				order_id: row.order_id,
				sku: row.sku,
				created_at: row.created_at,
			}),
		);
		if (!(await executeConditional(ShopOrders.insertIfNotExists(row)))) return false;
		if (row.next_check_at) {
			await this.scheduleCheck({
				slot: shopOrderCheckSlot(row.next_check_at),
				shard: shopOrderCheckShard(row.order_id),
				order_id: row.order_id,
				due_at: row.next_check_at,
			});
		}
		return true;
	}

	async find(orderId: bigint): Promise<ShopOrderRow | null> {
		return fetchOne<ShopOrderRow>(FETCH_ORDER_CQL.bind({order_id: orderId}));
	}

	// Compare-and-set on version; the caller rereads and retries when it loses.
	async patch(orderId: bigint, patch: ShopOrderPatch, expectedVersion: number): Promise<boolean> {
		const ops: Record<string, DbOp<unknown>> = {};
		for (const [column, value] of Object.entries({...patch, updated_at: new Date(), version: expectedVersion + 1})) {
			ops[column] = Db.set(value);
		}
		return executeConditional(ShopOrders.conditionalPatchByPk({order_id: orderId}, ops, {version: expectedVersion}));
	}

	// Every order, in token order; for one-off admin jobs only.
	async scanPage(limit: number, pageState: string | null): Promise<PagedQueryResult<ScannedShopOrder>> {
		return fetchPage<ScannedShopOrder>(
			SCAN_ORDERS_CQL,
			{},
			{pageSize: limit, pageState, readTimeout: BACKGROUND_READ_TIMEOUT_MS},
		);
	}

	// Newest first.
	async listForUser(userId: UserID, limit: number, beforeOrderId?: bigint): Promise<Array<ShopOrderByUserRow>> {
		return fetchMany<ShopOrderByUserRow>(
			userOrdersQuery(limit).bind({user_id: userId, before: beforeOrderId ?? NO_BEFORE}),
		);
	}

	async scheduleCheck(row: ShopOrderCheckRow): Promise<void> {
		await upsertOne(ShopOrderChecks.insertWithTtl(row, CHECK_TTL_SECONDS));
	}

	async listChecks(
		slot: number,
		shard: number,
		limit: number,
		afterOrderId?: bigint,
	): Promise<Array<ShopOrderCheckRow>> {
		return fetchMany<ShopOrderCheckRow>(checksQuery(limit).bind({slot, shard, after: afterOrderId ?? NO_AFTER}));
	}

	async deleteCheck(key: Pick<ShopOrderCheckRow, 'slot' | 'shard' | 'order_id'>): Promise<void> {
		await deleteOneOrMany(ShopOrderChecks.deleteByPk(key));
	}

	// The pending check row's key comes from next_check_at; nothing to delete when it is null.
	async deletePendingCheck(order: Pick<ShopOrderRow, 'order_id' | 'next_check_at'>): Promise<void> {
		if (!order.next_check_at) return;
		await this.deleteCheck({
			slot: shopOrderCheckSlot(order.next_check_at),
			shard: shopOrderCheckShard(order.order_id),
			order_id: order.order_id,
		});
	}
}
