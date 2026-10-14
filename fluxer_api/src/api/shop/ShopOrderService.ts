// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import type {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {
	SHOP_ORDER_CHECK_SHARDS,
	SHOP_ORDER_CHECK_SLOT_MS,
	type ShopOrderCheckRow,
	type ShopOrderRow,
} from '@app/api/database/types/ShopTypes';
import type {ISnowflakeService} from '@app/api/infrastructure/ISnowflakeService';
import {Logger} from '@app/api/Logger';
import type {User} from '@app/api/models/User';
import {buildCallbackUrl, createCallbackToken} from '@app/api/payriff/PayriffCallbackToken';
import {PAYRIFF_PAID_STATUSES, type PayriffClient} from '@app/api/payriff/PayriffClient';
import type {PayriffRateLimiter} from '@app/api/payriff/PayriffRateLimiter';
import {
	requestShopOrderVerify,
	shopVerifyFlagKey,
	type VerifyShopOrderPayload,
} from '@app/api/payriff/PayriffVerifyTrigger';
import type {PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import type {VisionaryService} from '@app/api/premium/visionary/VisionaryService';
import type {ShopCatalogService} from '@app/api/shop/ShopCatalogService';
import {type ShopOrderRepository, shopOrderCheckShard, shopOrderCheckSlot} from '@app/api/shop/ShopOrderRepository';
import {describeShopOrder, formatRateMicro, parseShopSku} from '@app/api/shop/ShopPricing';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {ShopBusyError} from '@fluxer/errors/src/domains/payment/ShopBusyError';
import {ShopTooManyOpenOrdersError} from '@fluxer/errors/src/domains/payment/ShopTooManyOpenOrdersError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import type {EquipCosmeticsRequest} from '@fluxer/schema/src/domains/cosmetics/CosmeticRequestSchemas';
import type {ShopAdminOrderResponse} from '@fluxer/schema/src/domains/shop/ShopAdminSchemas';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

export interface ShopOrderServiceDeps {
	orderRepository: ShopOrderRepository;
	catalogService: ShopCatalogService;
	payriffClient: PayriffClient;
	rateLimiter: PayriffRateLimiter;
	cosmeticService: CosmeticService;
	premiumLedgerService: PremiumLedgerService;
	visionaryService: VisionaryService;
	userRepository: Pick<UserRepository, 'findUnique'>;
	kvClient: IKVProvider;
	workerService: IWorkerService<WorkerTaskName>;
	snowflakeService: ISnowflakeService;
}

// Reconcile asks Payriff at most four times per order, counted from its creation.
export const SHOP_CHECK_SCHEDULE_MS = [2 * 60_000, 15 * 60_000, 3 * 3_600_000, 24 * 3_600_000] as const;
export const SHOP_CHECK_MIN_DELAY_MS = 60_000; // a late check is scheduled at least a minute ahead, never behind the cursor
export const SHOP_ORDER_REUSE_MS = 15 * 60_000;
export const SHOP_MAX_OPEN_ORDERS = 3;
export const SHOP_REFUSED_PROVIDER_STATUSES: ReadonlySet<string> = new Set(['DECLINED', 'CANCELED', 'EXPIRED']);

const CREATE_LOCK_SECONDS = 15;
const DELIVER_LOCK_SECONDS = 30;
// A bundle item may wait 5 s for its own delivery lock (CosmeticService.deliverOwned), then writes a few rows.
const BUNDLE_ITEM_LOCK_SECONDS = 10;
const LATE_PAYMENT_CHECK_MS = 2 * 60_000;
// Payriff answers a create within the client's 10 s timeout; an order still without a Payriff ID after this never got one.
const PROVIDER_ID_GRACE_MS = 10 * 60_000;
const MAX_ROUNDS = 5;
const RECENT_ORDERS = 10;
const CHECK_PAGE = 500;
const CURSOR_KEY = 'shop:checks:cursor';
const RECONCILE_LOCK_KEY = 'shop:checks:lock';
const RECONCILE_LOCK_SECONDS = 60;
const LAG_KEY = 'shop:checks:lag';
const LAG_TTL_SECONDS = 3600;

type Outcome = 'done' | 'deferred';
type OrderPatch = Parameters<ShopOrderRepository['patch']>[1];
type CheckKey = Pick<ShopOrderCheckRow, 'slot' | 'shard' | 'order_id'>;

export function mapShopOrder(row: ShopOrderRow): ShopOrderResponse {
	return {
		id: row.order_id.toString(),
		sku: row.sku,
		status: row.status,
		failure_reason: row.failure_reason ?? null,
		base_usd_cents: row.base_usd_cents,
		campaign_percent: row.campaign_percent,
		premium_percent: row.premium_percent,
		final_usd_cents: row.final_usd_cents,
		amount_azn_minor: row.amount_minor,
		display_currency: row.display_currency ?? null,
		display_amount_minor: row.display_amount_minor == null ? null : Number(row.display_amount_minor),
		display_rate_micro: row.display_rate_micro ?? null,
		usd_to_azn_rate: formatRateMicro(row.rate_micro),
		usd_to_azn_rate_micro: row.rate_micro,
		currency: 'AZN',
		payment_url: row.status === 'pending' ? (row.payment_url ?? null) : null,
		created_at: row.created_at.toISOString(),
		...(row.item_ids ? {item_ids: row.item_ids.map(String)} : {}),
	};
}

export function mapShopAdminOrder(row: ShopOrderRow): ShopAdminOrderResponse {
	const {payment_url: _paymentUrl, ...order} = mapShopOrder(row);
	return {
		...order,
		user_id: row.user_id.toString(),
		provider_order_id: row.provider_order_id ?? null,
		provider_status: row.provider_status ?? null,
		paid_at: row.paid_at?.toISOString() ?? null,
		granted_at: row.granted_at?.toISOString() ?? null,
		check_count: row.check_count,
	};
}

// Counted towards the open order limit, and reusable: unpaid, under fifteen minutes old, not refused by Payriff.
function isOpen(row: ShopOrderRow, now: number): boolean {
	return (
		row.status === 'pending' &&
		row.created_at.getTime() > now - SHOP_ORDER_REUSE_MS &&
		!SHOP_REFUSED_PROVIDER_STATUSES.has(row.provider_status ?? '')
	);
}

// The same frozen item list, order included; orders other than bundles have none on either side.
function sameItems(
	frozen: ReadonlyArray<bigint> | null | undefined,
	quoted: ReadonlyArray<bigint> | undefined,
): boolean {
	const left = frozen ?? [];
	const right = quoted ?? [];
	return left.length === right.length && left.every((id, index) => id === right[index]);
}

// Orders open, get checked with Payriff and are delivered here. Payriff's callback only
// triggers a check: money is what getOrder reads. Delivery runs only on a paid order, under a per-order lock, and ends
// with the paid → granted compare-and-set; the delivery records (cosmetic_grants, premium_grant_keys, the Visionary
// slot's order) stop a second delivery even when the lock is lost.
export class ShopOrderService {
	constructor(readonly deps: ShopOrderServiceDeps) {}

	async createOrder(user: User, sku: string): Promise<ShopOrderRow> {
		const {deps} = this;
		await deps.catalogService.prepareCheckout(user, sku, 'cached');
		const lockKey = `shop:order:create:${user.id}`;
		const lockToken = randomUUID();
		if (!(await deps.kvClient.acquireLock(lockKey, lockToken, CREATE_LOCK_SECONDS))) throw new ShopBusyError();
		try {
			// One binding quote from the tables, under the user lock, before deciding whether to reuse.
			const prepared = await deps.catalogService.prepareCheckout(user, sku, 'direct');
			const display = prepared.display!;
			const now = Date.now();
			const recent = await deps.orderRepository.listForUser(user.id, RECENT_ORDERS);
			const open = (await Promise.all(recent.map((entry) => deps.orderRepository.find(entry.order_id)))).filter(
				(row): row is ShopOrderRow => row !== null && isOpen(row, now),
			);
			const reusable = open.find(
				(row) =>
					row.sku === sku &&
					row.payment_url &&
					row.amount_minor === prepared.price.amountAznMinor &&
					row.final_usd_cents === prepared.price.finalUsdCents &&
					row.display_currency === display.currency &&
					row.display_amount_minor === BigInt(display.amountMinor) &&
					row.display_rate_micro === display.rateMicro &&
					sameItems(row.item_ids, prepared.bundle?.itemIds),
			);
			if (reusable) return reusable;
			if (open.length >= SHOP_MAX_OPEN_ORDERS) throw new ShopTooManyOpenOrdersError();
			if (!(await deps.rateLimiter.tryAcquire('create'))) {
				await deps.rateLimiter.recordBusyRefusal();
				throw new ShopBusyError();
			}
			const orderId = await deps.snowflakeService.generate();
			// A Visionary number is held before anything is written or Payriff is asked; none free refuses here.
			if (prepared.kind === 'visionary') await deps.visionaryService.holdForOrder(user.id, orderId);
			const {token, hash} = createCallbackToken();
			const createdAt = new Date();
			const {price} = prepared;
			const row: ShopOrderRow = {
				order_id: orderId,
				user_id: user.id,
				sku,
				item_id: prepared.item?.item_id ?? null,
				// Frozen from the bundle row read just above: delivery gives this list whatever the bundle becomes.
				item_ids: prepared.bundle?.itemIds ?? null,
				premium_months: prepared.months,
				base_usd_cents: price.baseUsdCents,
				campaign_percent: price.campaignPercent,
				premium_percent: price.premiumPercent,
				final_usd_cents: price.finalUsdCents,
				rate_micro: price.rateMicro,
				amount_minor: price.amountAznMinor,
				display_currency: display.currency,
				display_amount_minor: BigInt(display.amountMinor),
				display_rate_micro: display.rateMicro,
				currency: 'AZN',
				status: 'pending',
				failure_reason: null,
				provider: 'payriff',
				provider_order_id: null,
				provider_status: null,
				payment_url: null,
				callback_token_hash: hash,
				check_count: 0,
				next_check_at: new Date(createdAt.getTime() + SHOP_CHECK_SCHEDULE_MS[0]),
				created_at: createdAt,
				updated_at: createdAt,
				paid_at: null,
				granted_at: null,
				version: 1,
			};
			try {
				if (!(await deps.orderRepository.create(row))) throw new Error('Shop order ID already taken');
			} catch (error) {
				// No order was written: its number goes back now rather than when the hold ends.
				if (prepared.kind === 'visionary') await this.freeVisionaryNumber(orderId);
				throw error;
			}
			const opened = await deps.payriffClient.createOrder({
				amountMinor: row.amount_minor,
				description: describeShopOrder(
					row.order_id,
					{
						kind: prepared.kind,
						itemName: prepared.item?.name ?? prepared.bundle?.name ?? null,
						months: prepared.months,
					},
					row,
				),
				// The token lives only in this URL; the order keeps its hash.
				callbackUrl: buildCallbackUrl(orderId, token),
			});
			if (opened.kind !== 'ok') {
				if (opened.kind === 'rate_limited') await deps.rateLimiter.backOff();
				await this.finish(orderId, (current) =>
					current.status === 'pending' ? {status: 'failed', failure_reason: 'provider_error'} : null,
				);
				await deps.rateLimiter.recordBusyRefusal();
				throw new ShopBusyError();
			}
			const updated = await this.change(orderId, (current) =>
				current.status === 'pending' && !current.provider_order_id
					? {provider_order_id: opened.providerOrderId, payment_url: opened.paymentUrl}
					: null,
			);
			return updated?.after ?? row;
		} finally {
			await deps.kvClient.releaseLock(lockKey, lockToken);
		}
	}

	// Another account's order answers like an unknown one.
	async getOrderForUser(userId: UserID, orderId: bigint): Promise<ShopOrderRow> {
		const row = await this.deps.orderRepository.find(orderId);
		if (!row || row.user_id !== userId) throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		return row;
	}

	async getOrderForAdmin(orderId: bigint): Promise<ShopOrderRow> {
		const row = await this.deps.orderRepository.find(orderId);
		if (!row) throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		return row;
	}

	// One verifyShopOrder job. 'deferred': nothing decided (no budget, a 429, Payriff unreachable, delivery locked);
	// a callback job queues itself again, a reconcile job leaves its check row for a later run.
	async verifyOrder(payload: VerifyShopOrderPayload): Promise<Outcome> {
		const {orderRepository, payriffClient, rateLimiter} = this.deps;
		const orderId = BigInt(payload.orderId);
		const reconcile = payload.trigger === 'reconcile';
		const check: CheckKey | null =
			payload.slot !== undefined && payload.shard !== undefined
				? {slot: payload.slot, shard: payload.shard, order_id: orderId}
				: null;
		const done = async (): Promise<Outcome> => {
			if (check) await orderRepository.deleteCheck(check);
			return 'done';
		};
		let budgeted = payload.budgeted === true;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			const order = await orderRepository.find(orderId);
			if (!order || order.status === 'granted' || order.status === 'failed') return done();
			// An expired order leaves the schedule; only a callback (a late payment) looks at it again, or
			// the one check a callback job that gave up left it (leaveToReconcile).
			if (order.status === 'expired' && reconcile && !(check && isPendingCheck(order, check))) return done();
			if (order.status === 'paid') {
				const delivered = await this.deliverPaid(order);
				if (delivered === 'again') continue;
				return delivered === 'done' ? done() : 'deferred';
			}
			// A check row this order no longer waits on (rescheduled meanwhile): drop it and ask nobody.
			if (reconcile && check && !isPendingCheck(order, check)) return done();
			if (!order.provider_order_id) {
				if (order.created_at.getTime() > Date.now() - PROVIDER_ID_GRACE_MS) {
					return reconcile ? this.countCheck(order, check, {}) : 'done';
				}
				const failed = await this.finish(orderId, (current) =>
					current.status === order.status && !current.provider_order_id
						? {status: 'failed', failure_reason: 'provider_error'}
						: null,
				);
				if (!failed) continue;
				return done();
			}
			if (!budgeted) {
				if (!(await rateLimiter.tryAcquire('verify'))) return 'deferred';
				budgeted = true;
			}
			const answer = await payriffClient.getOrder(order.provider_order_id);
			if (answer.kind === 'rate_limited') {
				await rateLimiter.backOff();
				return 'deferred';
			}
			if (answer.kind !== 'ok') {
				if (reconcile) return this.countCheck(order, check, {});
				return answer.kind === 'transient' ? 'deferred' : 'done';
			}
			const providerStatus = answer.paymentStatus;
			const unpaid = (current: ShopOrderRow) => current.status === 'pending' || current.status === 'expired';
			if (PAYRIFF_PAID_STATUSES.has(providerStatus) && answer.operationType === 'PURCHASE') {
				if (answer.amountMinor === order.amount_minor && answer.currency === 'AZN') {
					// A late payment on an expired order has no check row left: it gets one, so a delivery the callback
					// job gives up on is still made by reconcile. Like countCheck: the row first, then the order; a lost
					// race leaves a row the job that finds it drops. The next round delivers it (or sees who did).
					// Read again after Payriff answered: an order another job marked paid meanwhile gets no row from this one.
					const fresh = await orderRepository.find(orderId);
					if (!fresh || !unpaid(fresh)) continue;
					const lateCheckAt = new Date(Date.now() + LATE_PAYMENT_CHECK_MS);
					const lateCheck = {
						slot: shopOrderCheckSlot(lateCheckAt),
						shard: shopOrderCheckShard(orderId),
						order_id: orderId,
						due_at: lateCheckAt,
					};
					if (!fresh.next_check_at) await orderRepository.scheduleCheck(lateCheck);
					const paid = await this.change(orderId, (current) =>
						unpaid(current)
							? {
									status: 'paid',
									paid_at: new Date(),
									provider_status: providerStatus,
									...(current.next_check_at ? {} : {next_check_at: lateCheckAt}),
								}
							: null,
					);
					// Expired (its row gone) between that read and this write: the row comes after the order here, so
					// the payment Payriff already confirmed is never asked about again without a token.
					if (paid && !paid.before.next_check_at && fresh.next_check_at) {
						await orderRepository.scheduleCheck(lateCheck);
					}
					continue;
				}
				const failed = await this.finish(orderId, (current) =>
					unpaid(current)
						? {status: 'failed', failure_reason: 'amount_mismatch', provider_status: providerStatus}
						: null,
				);
				if (!failed) continue;
				Logger.warn({orderId: payload.orderId, providerStatus}, 'Shop order payment does not match the order');
				return done();
			}
			if (providerStatus === 'EXPIRED' && order.status === 'pending') {
				const expired = await this.finish(orderId, (current) =>
					current.status === 'pending' ? {status: 'expired', provider_status: providerStatus} : null,
				);
				if (!expired) continue;
				return done();
			}
			if (reconcile) return this.countCheck(order, check, {provider_status: providerStatus});
			if (order.provider_status !== providerStatus) {
				await this.change(orderId, (current) =>
					current.status === order.status ? {provider_status: providerStatus} : null,
				);
			}
			return 'done';
		}
		return 'deferred';
	}

	// Walks the due check rows from the cursor slot to the current one, taking a Payriff token per row before queueing
	// its job. The cursor stays on the oldest slot that still had rows, so a row whose job was
	// deferred is found again; with no cursor the first run starts at the current slot. No table scan.
	// TEMPORARY: a row that keeps failing holds the cursor, and every run
	// rereads the slots after it until it settles or its 7 day TTL ends; the lag shows on the admin shop page and in a
	// warn log. Runs are 10 s apart: a cursor held 7 days rereads 2 016 slots × 16 shards ≈ 32 000 rows a run, about
	// 3 200 reads/s, and such a run can outlast its 60 s lock, so the next run reads the same slots at the same time.
	// Trigger: lag over 15 minutes. Path: move such a row forward by a slot instead of waiting on it.
	// TEMPORARY: the cursor lives in KV only. When Valkey loses it (restart without persistence, failover, a
	// flush) the next run starts at the current slot, and rows due in older slots are never read again: their orders
	// wait for a callback or a support lookup. Trigger: any Valkey data loss while orders are pending, or a paid order
	// found by support that reconcile never delivered. Path: start a missing cursor at now − 7 days (the row TTL; one
	// run of 2 016 slots × 16 shards of mostly empty reads) or keep the cursor in a Cassandra row.
	// One run at a time (null: another run holds the lock): runs start every 10 s, and two runs over the same rows would
	// both take a token for a row whose job only one of them queues. A run longer than the lock lets the next one in.
	async reconcile(now: Date): Promise<{queued: number; lagSeconds: number} | null> {
		const {kvClient} = this.deps;
		const lockToken = randomUUID();
		if (!(await kvClient.acquireLock(RECONCILE_LOCK_KEY, lockToken, RECONCILE_LOCK_SECONDS))) return null;
		try {
			return await this.reconcileChecks(now);
		} finally {
			await kvClient.releaseLock(RECONCILE_LOCK_KEY, lockToken);
		}
	}

	private async reconcileChecks(now: Date): Promise<{queued: number; lagSeconds: number}> {
		const {kvClient, orderRepository, rateLimiter} = this.deps;
		const currentSlot = shopOrderCheckSlot(now);
		const cursor = Number(await kvClient.get(CURSOR_KEY));
		const firstSlot = Number.isSafeInteger(cursor) && cursor > 0 && cursor < currentSlot ? cursor : currentSlot;
		let oldestWaiting = currentSlot;
		let queued = 0;
		let outOfBudget = false;
		for (let slot = firstSlot; slot <= currentSlot && !outOfBudget; slot++) {
			let waiting = false;
			for (let shard = 0; shard < SHOP_ORDER_CHECK_SHARDS && !outOfBudget; shard++) {
				let after: bigint | undefined;
				for (;;) {
					const rows = await orderRepository.listChecks(slot, shard, CHECK_PAGE, after);
					for (const row of rows) {
						waiting = true;
						if (row.due_at.getTime() > now.getTime()) continue;
						// Queued in the last two minutes and not settled yet: no token for it.
						if ((await kvClient.exists(shopVerifyFlagKey(row.order_id, 'reconcile'))) > 0) continue;
						if (!(await rateLimiter.tryAcquire('reconcile'))) {
							outOfBudget = true;
							break;
						}
						if (await requestShopOrderVerify(this.deps, row.order_id, 'reconcile', {slot, shard})) queued++;
					}
					if (outOfBudget || rows.length < CHECK_PAGE) break;
					after = rows[rows.length - 1]!.order_id;
				}
			}
			if (waiting || outOfBudget) oldestWaiting = Math.min(oldestWaiting, slot);
		}
		await kvClient.set(CURSOR_KEY, String(oldestWaiting));
		const lagSeconds =
			oldestWaiting < currentSlot ? Math.floor((now.getTime() - oldestWaiting * SHOP_ORDER_CHECK_SLOT_MS) / 1000) : 0;
		await kvClient.setex(LAG_KEY, LAG_TTL_SECONDS, String(lagSeconds));
		return {queued, lagSeconds};
	}

	// A callback job that gave up (no verify budget for its 30 tries, or a delivery that stayed locked) leaves the order
	// to reconcile: its check moves to a minute from now unless one is due sooner. An expired order gets that one check,
	// so a late payment the callback never read is still found. Like countCheck: the new row first, then the order; a
	// lost race leaves a row the job that finds it drops.
	async leaveToReconcile(orderId: bigint): Promise<void> {
		const {orderRepository} = this.deps;
		const order = await orderRepository.find(orderId);
		const dueAt = new Date(Date.now() + SHOP_CHECK_MIN_DELAY_MS);
		if (!order || order.status === 'granted' || order.status === 'failed') return;
		if (order.next_check_at && order.next_check_at.getTime() <= dueAt.getTime()) return;
		const next = {
			slot: shopOrderCheckSlot(dueAt),
			shard: shopOrderCheckShard(orderId),
			order_id: orderId,
			due_at: dueAt,
		};
		await orderRepository.scheduleCheck(next);
		if (!(await orderRepository.patch(orderId, {next_check_at: dueAt}, order.version))) return;
		if (order.next_check_at && shopOrderCheckSlot(order.next_check_at) !== next.slot) {
			await orderRepository.deletePendingCheck(order);
		}
	}

	// A reconcile check that reached any answer but no budget or a 429 counts: the next one is due on the schedule from
	// the creation time, never less than a minute ahead; the fourth expires the order. The row just checked goes,
	// unless the next check landed on the same row (a late check whose next one falls in the same slot).
	private async countCheck(order: ShopOrderRow, check: CheckKey | null, patch: OrderPatch): Promise<Outcome> {
		const {orderRepository} = this.deps;
		// A check leaveToReconcile pulled ahead of its time does not count: the order goes back to the one it was due.
		// Told by the due time the check row was written with (next_check_at), not this server's clock, which may lag.
		const early =
			order.status === 'pending' &&
			!!order.next_check_at &&
			order.next_check_at.getTime() < order.created_at.getTime() + (SHOP_CHECK_SCHEDULE_MS[order.check_count] ?? 0);
		const checkCount = early ? order.check_count : order.check_count + 1;
		let next: ShopOrderCheckRow | null = null;
		// An expired order was checked only for a late payment (leaveToReconcile): it leaves the schedule again.
		if (checkCount >= SHOP_CHECK_SCHEDULE_MS.length || order.status === 'expired') {
			const expired = await this.finish(order.order_id, (current) =>
				current.status === order.status
					? {...patch, status: 'expired', check_count: Math.min(checkCount, SHOP_CHECK_SCHEDULE_MS.length)}
					: null,
			);
			// Paid meanwhile: the row stays until the delivery that settles it.
			if (!expired) return 'done';
		} else {
			const dueAt = new Date(
				Math.max(
					order.created_at.getTime() + SHOP_CHECK_SCHEDULE_MS[checkCount]!,
					Date.now() + SHOP_CHECK_MIN_DELAY_MS,
				),
			);
			next = {
				slot: shopOrderCheckSlot(dueAt),
				shard: shopOrderCheckShard(order.order_id),
				order_id: order.order_id,
				due_at: dueAt,
			};
			await orderRepository.scheduleCheck(next);
			const counted = {...patch, check_count: checkCount, next_check_at: dueAt};
			// The order changed meanwhile: both rows stay. A job that counted the same check wrote this very row, and a
			// row the order no longer waits on is dropped, without asking Payriff, by the job that finds it.
			if (!(await orderRepository.patch(order.order_id, counted, order.version))) return 'done';
		}
		if (check && !(next && next.slot === check.slot && next.shard === check.shard)) {
			await orderRepository.deleteCheck(check);
		}
		return 'done';
	}

	private async deliverPaid(order: ShopOrderRow): Promise<Outcome | 'again'> {
		const {kvClient, orderRepository} = this.deps;
		const lockKey = `shop:order:deliver:${order.order_id}`;
		const lockToken = randomUUID();
		const lockSeconds = DELIVER_LOCK_SECONDS + (order.item_ids?.length ?? 0) * BUNDLE_ITEM_LOCK_SECONDS;
		if (!(await kvClient.acquireLock(lockKey, lockToken, lockSeconds))) return 'deferred';
		try {
			const current = await orderRepository.find(order.order_id);
			if (current?.status !== 'paid') return 'again';
			try {
				await this.deliver(current);
			} catch (error) {
				// The premium lock of a Visionary delivery is held by another premium write: try again later.
				if (error instanceof ResourceLockedError) return 'deferred';
				const reason = undeliverable(current, error);
				if (!reason) throw error;
				const failed = await this.finish(order.order_id, (row) =>
					row.status === 'paid' ? {status: 'failed', failure_reason: reason} : null,
				);
				if (!failed) return 'again';
				Logger.warn({orderId: order.order_id.toString()}, REFUND_BY_HAND[reason]);
				return 'done';
			}
			const granted = await this.finish(order.order_id, (row) =>
				row.status === 'paid' ? {status: 'granted', granted_at: new Date()} : null,
			);
			return granted ? 'done' : 'again';
		} finally {
			await kvClient.releaseLock(lockKey, lockToken);
		}
	}

	private async deliver(order: ShopOrderRow): Promise<void> {
		const orderId = order.order_id.toString();
		const ref = parseShopSku(order.sku);
		switch (ref?.kind) {
			case 'cosmetic': {
				const outcome = await this.deps.cosmeticService.deliverOwned(
					order.user_id,
					ref.itemId,
					`payriff:${orderId}`,
					'payriff',
				);
				if (outcome === 'already_owned') {
					Logger.warn({orderId}, 'Shop order paid for an item the account already owned; refund by hand');
				}
				return;
			}
			case 'premium': {
				await this.deps.premiumLedgerService.grant({
					userId: order.user_id,
					grantKey: orderId,
					duration: {unit: 'months', quantity: ref.months},
					source: 'payriff',
				});
				// Opening refuses a package to a Visionary; one that became a Visionary before paying got nothing from it.
				const user = await this.deps.userRepository.findUnique(order.user_id);
				if (user && this.deps.visionaryService.isVisionary(user)) {
					Logger.warn({orderId}, 'Premium order paid by a Visionary account; refund by hand');
				}
				return;
			}
			case 'visionary': {
				const delivery = await this.deps.visionaryService.deliverForOrder(order.user_id, order.order_id);
				if (delivery.outcome === 'already_visionary') {
					Logger.warn({orderId}, 'Visionary order paid by an account that already is a Visionary; refund by hand');
				}
				return;
			}
			case 'bundle':
				return this.deliverBundle(order);
			default:
				throw new Error(`Shop order ${orderId} has an unknown sku`);
		}
	}

	// Only the list frozen in the order, in bundle order, each item under its own grant key: a
	// shared 'payriff:<order_id>' would deliver the first item only. An item gone since the order opened is skipped like a
	// Visionary reward (şart 8). Items are given unworn; then the first item of each type this order gave goes on in one
	// user write and one USER_UPDATE. A retry finds the items given before already_delivered and wears the same ones.
	private async deliverBundle(order: ShopOrderRow): Promise<void> {
		const {cosmeticService} = this.deps;
		const orderId = order.order_id.toString();
		if (!order.item_ids) throw new Error(`Shop order ${orderId} has no item list`);
		const slots = new Map(
			(await cosmeticService.getItemsByIds(order.item_ids)).map((item) => [
				item.id,
				`${item.type}_id` as keyof EquipCosmeticsRequest,
			]),
		);
		const wear: EquipCosmeticsRequest = {};
		for (const itemId of order.item_ids) {
			const outcome = await cosmeticService
				.deliverOwned(order.user_id, itemId, `payriff:${orderId}:${itemId}`, 'payriff', {wear: false})
				.catch((error: unknown) => {
					// Only the missing item; a deleted account (UnknownUserError is a NotFoundError too) fails the order.
					if (!(error instanceof NotFoundError) || error.code !== APIErrorCodes.NOT_FOUND) throw error;
					Logger.warn({orderId, itemId: `${itemId}`}, 'Bundle item is gone; skipped, refund it by hand');
					return 'skipped' as const;
				});
			if (outcome === 'already_owned') {
				Logger.warn(
					{orderId, itemId: `${itemId}`},
					'Bundle item already owned; refund the whole order by hand and take its items back',
				);
			}
			const slot = slots.get(`${itemId}`);
			if (!slot || wear[slot] !== undefined) continue;
			// already_delivered: given by an earlier try of this order, or taken back by an admin since (no longer owned).
			if (
				outcome === 'delivered' ||
				(outcome === 'already_delivered' && (await cosmeticService.isOwned(order.user_id, itemId)))
			) {
				wear[slot] = itemId;
			}
		}
		if (Object.keys(wear).length === 0) return;
		const user = await this.deps.userRepository.findUnique(order.user_id);
		if (user) await cosmeticService.equip(user, wear);
	}

	// Compare-and-set on the order's version, rereading after a lost race. `patchFor` sees the current row and answers
	// the change, or null to leave the row as it is (then null is returned).
	private async change(
		orderId: bigint,
		patchFor: (current: ShopOrderRow) => OrderPatch | null,
	): Promise<{before: ShopOrderRow; after: ShopOrderRow} | null> {
		for (let attempt = 0; attempt < MAX_ROUNDS; attempt++) {
			const before = await this.deps.orderRepository.find(orderId);
			const patch = before && patchFor(before);
			if (!before || !patch) return null;
			if (await this.deps.orderRepository.patch(orderId, patch, before.version)) {
				return {before, after: {...before, ...patch, version: before.version + 1}};
			}
		}
		throw new Error('Shop order kept changing while it was being updated');
	}

	// A move to a final state (granted, failed, expired): its pending check row goes with it, and a
	// Visionary number held by an order that ends unpaid is freed (best effort: the hold also ends by itself).
	private async finish(
		orderId: bigint,
		patchFor: (current: ShopOrderRow) => OrderPatch | null,
	): Promise<ShopOrderRow | null> {
		const changed = await this.change(orderId, (current) => {
			const patch = patchFor(current);
			return patch && {...patch, next_check_at: null};
		});
		if (!changed) return null;
		await this.deps.orderRepository.deletePendingCheck(changed.before);
		const {after} = changed;
		if (after.status !== 'granted' && parseShopSku(after.sku)?.kind === 'visionary') {
			await this.freeVisionaryNumber(orderId);
		}
		return after;
	}

	private async freeVisionaryNumber(orderId: bigint): Promise<void> {
		await this.deps.visionaryService.releaseHold(orderId).catch((error: unknown) => {
			Logger.warn(
				{orderId: orderId.toString(), errorName: error instanceof Error ? error.name : 'unknown'},
				'Failed to free the Visionary number of an unpaid order',
			);
		});
	}
}

const REFUND_BY_HAND = {
	account_deleted: 'Shop order paid by a deleted account; refund by hand',
	item_deleted: 'Shop order paid for an item that no longer exists; refund by hand',
} as const;

// A paid order that can never be delivered fails, so it stops holding the reconcile cursor and spending its budget.
function undeliverable(order: ShopOrderRow, error: unknown): keyof typeof REFUND_BY_HAND | null {
	if (error instanceof UnknownUserError) return 'account_deleted';
	// deliverOwned's only 404 besides the unknown user: the item row is gone.
	if (parseShopSku(order.sku)?.kind === 'cosmetic' && error instanceof FluxerError && error.status === 404) {
		return 'item_deleted';
	}
	return null;
}

function isPendingCheck(order: ShopOrderRow, check: CheckKey): boolean {
	if (!order.next_check_at) return false;
	return (
		check.slot === shopOrderCheckSlot(order.next_check_at) &&
		check.shard === shopOrderCheckShard(order.order_id) &&
		check.order_id === order.order_id
	);
}
