// SPDX-License-Identifier: AGPL-3.0-or-later

import {getShopOrderService} from '@app/api/middleware/ServiceSingletons';
import type {WorkerTaskHandler} from '@pkgs/worker/src/contracts/WorkerTask';
import {z} from 'zod';

const MAX_CALLBACK_ATTEMPTS = 30;
const CALLBACK_RETRY_MS = 10_000;

// Worker payloads are JSON: the order ID travels as a string.
const PayloadSchema = z.object({
	orderId: z.string().regex(/^[1-9]\d{0,18}$/u),
	trigger: z.enum(['callback', 'reconcile']),
	attempt: z.number().int().min(0).optional(),
	slot: z.number().int().optional(),
	shard: z.number().int().optional(),
	budgeted: z.boolean().optional(),
});

// Asks Payriff about one order and delivers it once paid. A callback check that could not decide (no budget, a 429,
// Payriff unreachable, delivery locked) comes back in 10 s, at most 30 times, then leaves the order to reconcile; a
// reconcile one leaves its check row for the next run.
// TEMPORARY: runs on the lifecycle lane (8 at a time); give the shop its own lane once the
// lifecycle queue latency passes 30 s.
const verifyShopOrder: WorkerTaskHandler = async (rawPayload, helpers) => {
	const payload = PayloadSchema.parse(rawPayload);
	const outcome = await getShopOrderService().verifyOrder(payload);
	const attempt = payload.attempt ?? 0;
	if (outcome === 'deferred' && payload.trigger === 'callback' && attempt < MAX_CALLBACK_ATTEMPTS) {
		await helpers.addJob(
			'verifyShopOrder',
			{orderId: payload.orderId, trigger: 'callback', attempt: attempt + 1},
			{runAt: new Date(Date.now() + CALLBACK_RETRY_MS)},
		);
	} else if (outcome === 'deferred' && payload.trigger === 'callback') {
		await getShopOrderService().leaveToReconcile(BigInt(payload.orderId));
	}
};

export default verifyShopOrder;
