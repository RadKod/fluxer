// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	DISCOVER_REFRESH_CHANNEL,
	EVICTION_MARGIN_MS,
	EVICTION_MEMORY_MS,
	FeedDiscoverRepository,
} from '@app/api/feed/discover/FeedDiscoverRepository';
import type {FeedPostBase} from '@app/api/feed/FeedTimelineService';
import {Logger} from '@app/api/Logger';
import {RefreshSubscription} from '@app/api/utils/RefreshSubscription';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

export interface DiscoverEntry {
	authorId: string;
	post: FeedPostBase;
}

export interface DiscoverSnapshot {
	version: number;
	entries: Array<DiscoverEntry>;
}

const REFRESH_INTERVAL_MS = 20_000;
const REFRESH_JITTER_MS = 5_000;
const EMPTY: DiscoverSnapshot = {version: 0, entries: []};

// Every API process keeps the latest Keşfet snapshot in memory (a page costs no shared read of the list). It
// reads the snapshot every 20-25 s on its own clock, so processes spread their reads; the channel carries evictions
// (a deleted, reported or banned post), applied at once and remembered for two minutes. A process that starts or
// reconnects reads, with the snapshot, every eviction since shortly before that snapshot was built, however old it is. A missing snapshot key keeps the last one; a failed read never stops the
// API from starting.
// TEMPORARY: one snapshot key read by every process. Trigger: > 200 API processes or over_budget above 0 in the
// build log (the build caps the snapshot at 2 MB and logs its size). Path: N copies of the key; a process reads copy
// hash(pid) % N.
export class FeedDiscoverCache {
	private snapshot: DiscoverSnapshot = EMPTY;
	private repository: FeedDiscoverRepository | null = null;
	private kvClient: IKVProvider | null = null;
	private readonly evicted = new Map<string, number>();
	private readonly refreshSubscription = new RefreshSubscription({
		name: 'feed discover cache',
		channels: [DISCOVER_REFRESH_CHANNEL],
		refresh: () => this.refresh(),
		shouldRefresh: (_channel, message) => {
			this.evict(message);
			return false;
		},
		periodicIntervalMs: () => REFRESH_INTERVAL_MS + Math.floor(Math.random() * REFRESH_JITTER_MS),
		onRefreshError: (error, trigger) =>
			Logger.warn({error, trigger}, 'Refreshing the Keşfet snapshot failed; keeping the last one'),
	});

	setRefreshSubscriber(kvClient: IKVProvider | null): void {
		this.kvClient = kvClient;
		this.repository = kvClient ? new FeedDiscoverRepository(kvClient) : null;
	}

	initialize(): Promise<void> {
		return this.refreshSubscription.start(this.kvClient);
	}

	shutdown(): Promise<void> {
		return this.refreshSubscription.stop();
	}

	current(): DiscoverSnapshot {
		return this.snapshot;
	}

	async refresh(): Promise<void> {
		if (!this.repository) return;
		const now = Date.now();
		let next: DiscoverSnapshot | null;
		try {
			next = await this.repository.getSnapshot();
		} catch (error) {
			// Also the very first read at startup: warn and keep what we have (empty at first), never fail the API start.
			Logger.warn({error}, 'Reading the Keşfet snapshot failed; keeping the last one');
			return;
		}
		const base = next ?? this.snapshot;
		const since = Math.min(now - EVICTION_MEMORY_MS, base.version - EVICTION_MARGIN_MS);
		const recent = await this.repository.listEvictionsSince(since).catch((error: unknown) => {
			Logger.warn({error}, 'Reading Keşfet evictions failed');
			return null;
		});
		// Without the evictions, a snapshot older than the in-memory eviction memory could bring removed posts back.
		if (recent === null && next !== null && now - next.version > EVICTION_MEMORY_MS) return;
		for (const key of recent ?? []) this.evicted.set(key, now + EVICTION_MEMORY_MS);
		this.snapshot = {version: base.version, entries: this.withoutEvicted(base.entries)};
	}

	/** `post:<id>` or `author:<id>`. */
	evict(message: string): void {
		this.evicted.set(message, Date.now() + EVICTION_MEMORY_MS);
		this.snapshot = {version: this.snapshot.version, entries: this.withoutEvicted(this.snapshot.entries)};
	}

	resetForTesting(): void {
		void this.shutdown().catch(() => undefined);
		this.snapshot = EMPTY;
		this.kvClient = null;
		this.repository = null;
		this.evicted.clear();
	}

	private withoutEvicted(entries: Array<DiscoverEntry>): Array<DiscoverEntry> {
		const now = Date.now();
		for (const [key, until] of this.evicted) if (until <= now) this.evicted.delete(key);
		if (this.evicted.size === 0) return entries;
		return entries.filter(
			(entry) => !this.evicted.has(`post:${entry.post.id}`) && !this.evicted.has(`author:${entry.authorId}`),
		);
	}
}

export const feedDiscoverCache = new FeedDiscoverCache();
