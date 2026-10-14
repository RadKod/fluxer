// SPDX-License-Identifier: AGPL-3.0-or-later

import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

export type ShopVerifyTrigger = 'callback' | 'reconcile';

export interface VerifyShopOrderPayload {
	orderId: string; // string: worker payloads are JSON (HttpWorkerQueue.ts:157), BigInt does not serialise
	trigger: ShopVerifyTrigger;
	attempt?: number;
	slot?: number;
	shard?: number;
	budgeted?: boolean; // reconcile took the Payriff token before queueing
}

export const SHOP_CALLBACK_CHECKS_PER_HOUR = 10;

const FLAG_SECONDS: Record<ShopVerifyTrigger, number> = {callback: 30, reconcile: 120};
const CALLBACK_COUNTER_TTL_SECONDS = 2 * 3600;

// Separate flags so a reconcile in flight never swallows a callback.
export function shopVerifyFlagKey(orderId: bigint, trigger: ShopVerifyTrigger): string {
	return `shop:order:verify:${trigger}:${orderId}`;
}

// Queues one verifyShopOrder job. Repeats inside the flag's window (30 s callback, 120 s reconcile) queue nothing and,
// for callbacks, count nothing; the flag is never deleted when the job starts, it expires. A callback also counts
// towards SHOP_CALLBACK_CHECKS_PER_HOUR per order, so replaying one's own return link cannot drain the verify budget;
// reconcile still checks the order on its own budget.
export async function requestShopOrderVerify(
	deps: {kvClient: IKVProvider; workerService: IWorkerService<WorkerTaskName>},
	orderId: bigint,
	trigger: ShopVerifyTrigger,
	check?: {slot: number; shard: number},
): Promise<boolean> {
	if (!(await deps.kvClient.setnx(shopVerifyFlagKey(orderId, trigger), '1', FLAG_SECONDS[trigger]))) return false;
	if (trigger === 'reconcile') {
		await deps.workerService.addJob('verifyShopOrder', {
			orderId: orderId.toString(),
			trigger,
			...check,
			budgeted: true,
		});
		return true;
	}
	const counterKey = `shop:order:callback-checks:${orderId}:${Math.floor(Date.now() / 3_600_000)}`;
	const checks = await deps.kvClient.incr(counterKey);
	await deps.kvClient.expire(counterKey, CALLBACK_COUNTER_TTL_SECONDS);
	if (checks > SHOP_CALLBACK_CHECKS_PER_HOUR) return false;
	await deps.workerService.addJob('verifyShopOrder', {orderId: orderId.toString(), trigger});
	return true;
}
