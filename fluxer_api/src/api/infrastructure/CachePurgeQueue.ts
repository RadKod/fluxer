// SPDX-License-Identifier: AGPL-3.0-or-later

import {canonicalizePurgeUrl} from '@app/api/infrastructure/CachePurgePaths';
import {Logger} from '@app/api/Logger';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

interface PurgeUrlOptions {
	// Legal and moderation removals: every run purges these before any ordinary prefix.
	priority?: boolean;
}

export interface IPurgeQueue {
	addUrls(urls: Array<string>, options?: PurgeUrlOptions): Promise<void>;
}

interface CachePurgeBatch {
	// Priority prefixes come first, so an adapter with a budget spends it on them first.
	prefixes: Array<string>;
	priority: Array<string>;
}

// One hash tag keeps the queues and their bucket in one cluster slot, which the dequeue script needs.
const QUEUE_KEY = 'cache_purge:{q}:queue';
const PRIORITY_KEY = 'cache_purge:{q}:priority';
const BUDGET_KEY = 'cache_purge:{q}:budget';
// The untagged queue of earlier releases, drained on every run because their API pods may still write it.
const LEGACY_QUEUE_KEY = 'cache_purge:queue';
const LEGACY_MOVE_BATCH = 1000;
const REJECTED_KEY = 'cache_purge:rejected';
const MAX_TOKENS = 120;
const REFILL_RATE = 5;
const REFILL_INTERVAL_MS = 1000;

export class CachePurgeQueue implements IPurgeQueue {
	constructor(private readonly kvClient: IKVProvider) {}

	async addUrls(urls: Array<string>, {priority = false}: PurgeUrlOptions = {}): Promise<void> {
		const prefixes = new Set<string>();
		for (const url of urls) {
			const canonical = canonicalizePurgeUrl(url);
			if (canonical.length === 0) {
				Logger.warn({url}, 'Skipped a cache purge URL that is not a media CDN object');
				continue;
			}
			for (const prefix of canonical) {
				prefixes.add(prefix);
			}
		}
		if (prefixes.size === 0) {
			return;
		}
		try {
			await this.kvClient.sadd(priority ? PRIORITY_KEY : QUEUE_KEY, ...prefixes);
			Logger.debug({prefixes: prefixes.size, priority}, 'Added prefixes to the cache purge queue');
		} catch (error) {
			Logger.error({error, prefixes: prefixes.size, priority}, 'Failed to add prefixes to the cache purge queue');
			throw error;
		}
	}

	async dequeueBatch(): Promise<CachePurgeBatch> {
		await this.moveLegacyQueue();
		const priority = await this.dequeueFrom(PRIORITY_KEY, MAX_TOKENS);
		const room = MAX_TOKENS - priority.length;
		const ordinary = room > 0 ? await this.dequeueFrom(QUEUE_KEY, room) : [];
		return {prefixes: [...priority, ...ordinary], priority};
	}

	async requeue(prefixes: ReadonlyArray<string>): Promise<void> {
		if (prefixes.length === 0) {
			return;
		}
		try {
			await this.kvClient.sadd(QUEUE_KEY, ...prefixes);
		} catch (error) {
			Logger.error({error, prefixes: prefixes.length}, 'Failed to requeue cache purge prefixes');
			throw error;
		}
	}

	// Requeues, including the unsent rest an adapter hands back when its budget runs out, land in the ordinary
	// queue. This moves the priority prefixes of a batch that are waiting there back to the priority queue.
	async restorePriority(prefixes: ReadonlyArray<string>): Promise<void> {
		if (prefixes.length === 0) {
			return;
		}
		const pipeline = this.kvClient.pipeline();
		for (const prefix of prefixes) {
			pipeline.srem(QUEUE_KEY, prefix);
		}
		const results = await pipeline.exec();
		const waiting = prefixes.filter((_, index) => results[index]?.[1] === 1);
		if (waiting.length > 0) {
			await this.kvClient.sadd(PRIORITY_KEY, ...waiting);
		}
	}

	async reject(prefixes: ReadonlyArray<string>): Promise<void> {
		if (prefixes.length === 0) {
			return;
		}
		await this.kvClient.sadd(REJECTED_KEY, ...prefixes);
	}

	private async dequeueFrom(queueKey: string, maxItems: number): Promise<Array<string>> {
		const batch = await this.kvClient.dequeuePurgeBatch(
			queueKey,
			BUDGET_KEY,
			maxItems,
			MAX_TOKENS,
			REFILL_RATE,
			REFILL_INTERVAL_MS,
		);
		return batch.entries;
	}

	private async moveLegacyQueue(): Promise<void> {
		const legacy = await this.kvClient.spop(LEGACY_QUEUE_KEY, LEGACY_MOVE_BATCH);
		if (legacy.length === 0) {
			return;
		}
		try {
			await this.kvClient.sadd(QUEUE_KEY, ...legacy);
		} catch (error) {
			await this.kvClient.sadd(LEGACY_QUEUE_KEY, ...legacy);
			throw error;
		}
	}
}

export class NoopPurgeQueue implements IPurgeQueue {
	async addUrls(_urls: Array<string>): Promise<void> {}
}

// For removals that must leave the CDN first (NCMEC, admin deletions) through helpers that take a plain queue.
export function priorityPurgeQueue(queue: IPurgeQueue): IPurgeQueue {
	return {addUrls: (urls) => queue.addUrls(urls, {priority: true})};
}
