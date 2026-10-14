// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {FEED_VIEW_COUNT_COUNTER} from '@app/api/feed/interaction/FeedInteractionCounters';
import {verifyFeedViewTicket} from '@app/api/feed/views/FeedViews';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

const FEED_VIEW_GATE_SECONDS = 60;
// TEMPORARY: one merge step per API process; path: hand batches to the worker by post partition over JetStream
// for a second merge and one Lua per partition, or raise this to 15–30 s; trigger: the minute summary below.
const FEED_VIEW_BUFFER_FLUSH_MS = 5000;
const FEED_VIEW_BUFFER_MAX_POSTS = 50_000;
const FEED_VIEW_ADD_CONCURRENCY = 32;
const SUMMARY_INTERVAL_MS = 60_000;
const NO_SUMMARY = {posts: 0, views: 0, dropped: 0, ms: 0};

export const feedViewGateKey = (userId: UserID) => `feed:views:gate:${userId}`;

interface FeedViewServiceDeps {
	kv: Pick<IKVProvider, 'setnx' | 'ttl'>;
	counters: Pick<KVCounterService, 'add'>;
	enabled: () => boolean;
	// Tests only; undefined signs with the configured secret.
	secret?: string;
}

// Views are never stored one by one: a checked batch only adds to a
// per-process count per post, written to the KV view counters every 5 s, which the views lane flushes to feed_posts.
export class FeedViewService {
	private buffer = new Map<string, number>();
	private timer: NodeJS.Timeout | null = null;
	private flushing: Promise<void> | null = null;
	private summary = {...NO_SUMMARY};
	private summaryAt = Date.now();

	constructor(private readonly deps: FeedViewServiceDeps) {}

	/**
	 * 403 while feature_feed_views is 0; forged, foreign and expired tickets are dropped without a word; a post named
	 * twice counts once; the caller passes the gate once a minute (RATE_LIMIT_BYPASS too), else 429 with the time left.
	 */
	async record(viewerId: UserID, views: ReadonlyArray<{id: bigint; token: string}>, nowMs = Date.now()): Promise<void> {
		if (!this.deps.enabled()) throw new FeatureTemporarilyDisabledError();
		const seen = new Set<bigint>();
		for (const {id, token} of views) {
			if (verifyFeedViewTicket(viewerId, id, token, nowMs, this.deps.secret)) seen.add(id);
		}
		if (seen.size === 0) return;
		await this.passGate(viewerId, nowMs);
		for (const postId of seen) this.add(postId.toString());
	}

	/** Writes what the buffer holds; while a write runs, returns that one. */
	flush(): Promise<void> {
		if (this.flushing) return this.flushing;
		if (this.buffer.size === 0) {
			this.logSummaryIfDue();
			return Promise.resolve();
		}
		const batch = this.buffer;
		this.buffer = new Map();
		this.flushing = this.write(batch).finally(() => {
			this.flushing = null;
		});
		return this.flushing;
	}

	async shutdown(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.flushing;
		await this.flush();
	}

	private async passGate(viewerId: UserID, nowMs: number): Promise<void> {
		const key = feedViewGateKey(viewerId);
		if (await this.deps.kv.setnx(key, '1', FEED_VIEW_GATE_SECONDS)) return;
		const ttl = await this.deps.kv.ttl(key);
		const retryAfter = ttl > 0 ? ttl : 1;
		throw new RateLimitError({retryAfter, limit: 1, resetTime: new Date(nowMs + retryAfter * 1000), scope: 'user'});
	}

	// A full buffer starts a flush, which empties it at once; while that flush runs, views of new posts are dropped.
	private add(postId: string): void {
		const count = this.buffer.get(postId);
		if (count !== undefined) {
			this.buffer.set(postId, count + 1);
			return;
		}
		if (this.buffer.size >= FEED_VIEW_BUFFER_MAX_POSTS) {
			void this.flush();
			if (this.buffer.size >= FEED_VIEW_BUFFER_MAX_POSTS) {
				this.summary.dropped++;
				return;
			}
		}
		this.buffer.set(postId, 1);
		this.timer ??= setInterval(() => void this.flush(), FEED_VIEW_BUFFER_FLUSH_MS).unref();
	}

	// A failed add loses that post's views of this batch: adding them again could count them twice.
	private async write(batch: Map<string, number>): Promise<void> {
		const startedAt = Date.now();
		let failed = 0;
		let error: unknown;
		await mapWithConcurrency([...batch], FEED_VIEW_ADD_CONCURRENCY, async ([postId, count]) => {
			try {
				await this.deps.counters.add(FEED_VIEW_COUNT_COUNTER, postId, count);
			} catch (caught) {
				failed++;
				error ??= caught;
			}
		});
		if (failed > 0) Logger.warn({error, failed}, 'Adding feed views to the KV counters failed; those views are lost');
		let views = 0;
		for (const count of batch.values()) views += count;
		this.summary.posts += batch.size;
		this.summary.views += views;
		this.summary.ms += Date.now() - startedAt;
		this.logSummaryIfDue();
	}

	// At most one line a minute per process, only when something happened: the temporary buffer trigger.
	private logSummaryIfDue(): void {
		const now = Date.now();
		if (now - this.summaryAt < SUMMARY_INTERVAL_MS) return;
		const summary = this.summary;
		if (summary.posts + summary.dropped > 0) {
			Logger[summary.dropped > 0 ? 'warn' : 'info'](summary, 'Feed view buffer flushed');
		}
		this.summary = {...NO_SUMMARY};
		this.summaryAt = now;
	}
}
