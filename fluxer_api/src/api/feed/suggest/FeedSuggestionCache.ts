// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	DISCOVER_REFRESH_CHANNEL,
	EVICTION_MARGIN_MS,
	EVICTION_MEMORY_MS,
	FeedDiscoverRepository,
} from '@app/api/feed/discover/FeedDiscoverRepository';
import {FeedSuggestionRepository} from '@app/api/feed/suggest/FeedSuggestionRepository';
import {type FeedSuggestionSnapshot, SUGGESTION_POOL_MAX_AGE_MS} from '@app/api/feed/suggest/FeedSuggestionService';
import {Logger} from '@app/api/Logger';
import {RefreshSubscription} from '@app/api/utils/RefreshSubscription';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

const REFRESH_INTERVAL_MS = 20_000;
const REFRESH_JITTER_MS = 5_000;
const AUTHOR_PREFIX = 'author:';
const EMPTY: FeedSuggestionSnapshot = {version: 0, users: [], guilds: []};

// Every API process keeps the latest suggestion snapshot: a page costs no shared read. The Keşfet channel's
// author evictions (a ban, a new hiding flag) apply at once and stay until a snapshot built after them comes, at most
// 10 minutes (the pool's own limit) plus the 10 s build margin, not Keşfet's 120 s: this snapshot is valid 10 minutes. A
// process that starts reads the evictions Keşfet still keeps (its build prunes them), so a just-started process may show
// a banned account until the next build (≤1 build interval); following is refused anyway, the pool path reads the
// account live. An eviction read again from Keşfet's ZSET after a newer snapshot settled it counts as new (that read
// carries no time), so an account back in the pool stays out a little longer: up to 120 s after the eviction plus one
// build. It errs toward hiding.
// TEMPORARY: one snapshot key read by every API process every 20-25 s. Trigger: more than 200 API processes or
// `bytes` above 256 KB in the suggestion build log. Path: N copies of the key; a process reads copy hash(pid) % N.
export class FeedSuggestionCache {
	private snapshot: FeedSuggestionSnapshot = EMPTY;
	private repository: FeedSuggestionRepository | null = null;
	private discoverRepository: FeedDiscoverRepository | null = null;
	private kvClient: IKVProvider | null = null;
	// User ID → when this process learned of the eviction.
	private readonly evicted = new Map<string, number>();
	private readonly refreshSubscription = new RefreshSubscription({
		name: 'feed suggestion cache',
		channels: [DISCOVER_REFRESH_CHANNEL],
		refresh: () => this.refresh(),
		shouldRefresh: (_channel, message) => {
			this.evict(message);
			return false;
		},
		periodicIntervalMs: () => REFRESH_INTERVAL_MS + Math.floor(Math.random() * REFRESH_JITTER_MS),
		onRefreshError: (error, trigger) =>
			Logger.warn({error, trigger}, 'Refreshing the suggestion snapshot failed; keeping the last one'),
	});

	setRefreshSubscriber(kvClient: IKVProvider | null): void {
		this.kvClient = kvClient;
		this.repository = kvClient ? new FeedSuggestionRepository(kvClient) : null;
		this.discoverRepository = kvClient ? new FeedDiscoverRepository(kvClient) : null;
	}

	initialize(): Promise<void> {
		return this.refreshSubscription.start(this.kvClient);
	}

	shutdown(): Promise<void> {
		return this.refreshSubscription.stop();
	}

	async refresh(): Promise<void> {
		if (!this.repository || !this.discoverRepository) return;
		const now = Date.now();
		let next: FeedSuggestionSnapshot | null;
		try {
			next = await this.repository.getSnapshot();
		} catch (error) {
			// Also the very first read at startup: warn and keep what we have (empty at first), never fail the API start.
			Logger.warn({error}, 'Reading the suggestion snapshot failed; keeping the last one');
			return;
		}
		const base = next ?? this.snapshot;
		const recent = await this.discoverRepository
			.listEvictionsSince(Math.min(now - EVICTION_MEMORY_MS, base.version - EVICTION_MARGIN_MS))
			.catch((error: unknown) => {
				Logger.warn({error}, 'Reading Keşfet evictions for the suggestions failed');
				return null;
			});
		// As in FeedDiscoverCache: without the evictions, a snapshot older than the eviction memory could bring a banned
		// account back.
		if (recent === null && next !== null && now - next.version > EVICTION_MEMORY_MS) return;
		for (const key of recent ?? []) {
			const id = key.startsWith(AUTHOR_PREFIX) ? key.slice(AUTHOR_PREFIX.length) : null;
			if (id !== null && !this.evicted.has(id)) this.evicted.set(id, now);
		}
		this.snapshot = base;
		// Settled by a snapshot built after it, or kept past the point where any snapshot it could apply to is too old to
		// be read (the margin: a snapshot built up to 10 s after an eviction may still hold the account).
		for (const [id, seenAt] of this.evicted) {
			if (
				seenAt + EVICTION_MARGIN_MS < base.version ||
				now - seenAt > SUGGESTION_POOL_MAX_AGE_MS + EVICTION_MARGIN_MS
			) {
				this.evicted.delete(id);
			}
		}
	}

	/** `author:<id>` drops the account from the people pool; `post:<id>` (Keşfet's own) changes nothing here. */
	evict(message: string): void {
		if (message.startsWith(AUTHOR_PREFIX)) this.evicted.set(message.slice(AUTHOR_PREFIX.length), Date.now());
	}

	/** The pool as a request may use it: empty once 10 minutes old, without the evicted accounts. */
	fresh(nowMs = Date.now()): FeedSuggestionSnapshot {
		const {version, users, guilds} = this.snapshot;
		if (nowMs - version > SUGGESTION_POOL_MAX_AGE_MS) return {version, users: [], guilds: []};
		if (this.evicted.size === 0) return this.snapshot;
		return {version, users: users.filter((user) => !this.evicted.has(user.id)), guilds};
	}

	resetForTesting(): void {
		void this.shutdown().catch(() => undefined);
		this.snapshot = EMPTY;
		this.kvClient = null;
		this.repository = null;
		this.discoverRepository = null;
		this.evicted.clear();
	}
}

export const feedSuggestionCache = new FeedSuggestionCache();
