// SPDX-License-Identifier: AGPL-3.0-or-later

import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

export type PayriffBudget = 'verify' | 'create' | 'reconcile';

interface PayriffBucket {
	key: string;
	maxTokens: number;
	refillRate: number;
	refillIntervalMs: number;
}

// TEMPORARY: 2 requests/s total against Payriff's observed 3/s, split so reconcile keeps up with 0.3
// orders/s even when every order is abandoned; triggers: busy count, reconcile lag, and 429 responses.
// The three full buckets together stay under Payriff's observed burst of 30 (6 + 10 + 12 = 28). A quota rise grows
// the three rates together (1: 1.7: 4) and the bucket sizes only as far as the new burst allows.
// Reconcile takes its tokens in one run every 10 s (WorkerMain cron). A refill drops the part of an interval not yet
// full, so a run a few ms early would lose a coarse interval (6 tokens in 5 s: ~0.9/s); one token per 833 ms loses at
// most one token a run (1.1–1.2/s).
const BUCKETS: Record<PayriffBudget, PayriffBucket> = {
	create: {key: 'payriff:budget:create', maxTokens: 6, refillRate: 3, refillIntervalMs: 10_000},
	verify: {key: 'payriff:budget:verify', maxTokens: 10, refillRate: 1, refillIntervalMs: 2_000},
	reconcile: {key: 'payriff:budget:reconcile', maxTokens: 12, refillRate: 1, refillIntervalMs: 833},
};
const BACKOFF_KEY = 'payriff:backoff';
const BACKOFF_SECONDS = 30;
const BUSY_COUNTER_TTL_SECONDS = 2 * 3600;

function busyKey(hour: number): string {
	return `shop:busy:${hour}`;
}

function currentHour(): number {
	return Math.floor(Date.now() / 3_600_000);
}

// One KV token bucket per use, shared by every API and worker process, so a callback flood cannot starve reconcile
// and reconcile cannot starve callbacks. tryConsumeTokens answers the number of tokens handed out (KV client and mock).
export class PayriffRateLimiter {
	constructor(private readonly deps: {kvClient: IKVProvider}) {}

	// false while backing off after a 429
	async tryAcquire(budget: PayriffBudget): Promise<boolean> {
		if (await this.isBackingOff()) return false;
		const {key, maxTokens, refillRate, refillIntervalMs} = BUCKETS[budget];
		return (await this.deps.kvClient.tryConsumeTokens(key, 1, maxTokens, refillRate, refillIntervalMs)) > 0;
	}

	// 30 s for every budget (after a 429)
	async backOff(): Promise<void> {
		await this.deps.kvClient.setex(BACKOFF_KEY, BACKOFF_SECONDS, '1');
	}

	async isBackingOff(): Promise<boolean> {
		return (await this.deps.kvClient.exists(BACKOFF_KEY)) > 0;
	}

	// Health counter for the admin shop page: orders refused with SHOP_BUSY.
	async recordBusyRefusal(): Promise<void> {
		const key = busyKey(currentHour());
		await this.deps.kvClient.incr(key);
		await this.deps.kvClient.expire(key, BUSY_COUNTER_TTL_SECONDS);
	}

	// The current and the previous hour; two reads, since the two keys may sit on different cluster slots.
	async busyRefusalsLastHour(): Promise<number> {
		const hour = currentHour();
		const counts = await Promise.all([hour, hour - 1].map((h) => this.deps.kvClient.get(busyKey(h))));
		return counts.reduce((sum, count) => sum + Number(count ?? 0), 0);
	}
}
