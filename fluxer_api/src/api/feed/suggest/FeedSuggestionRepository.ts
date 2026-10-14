// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {FeedSuggestionSnapshot} from '@app/api/feed/suggest/FeedSuggestionService';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

const SNAPSHOT_KEY = 'feed:suggest:snapshot';
// The pool's own limit (SUGGESTION_POOL_MAX_AGE_MS): a snapshot no build replaced for 10 minutes is gone from KV too.
const SNAPSHOT_TTL_SECONDS = 600;
const BUILD_KEY = 'feed:suggest:build';
const BUILD_GATE_SECONDS = 50;
// A day and two hours: the builds of a UTC day and one that started just before midnight all find it.
const DAY_SEED_TTL_SECONDS = 26 * 3600;

// The suggestion pool's KV state: the snapshot every API process reads, the build gate and the day seed. The follower
// ranking the build reads lives with the follow data (FollowRepository).
export class FeedSuggestionRepository {
	constructor(private readonly kv: IKVProvider) {}

	async getSnapshot(): Promise<FeedSuggestionSnapshot | null> {
		const raw = await this.kv.get(SNAPSHOT_KEY);
		return raw === null ? null : (JSON.parse(raw) as FeedSuggestionSnapshot);
	}

	/** Returns the stored size in bytes, for the build log (the GEÇİCİ-B trigger in FeedSuggestionCache). */
	async putSnapshot(snapshot: FeedSuggestionSnapshot): Promise<number> {
		const raw = JSON.stringify(snapshot);
		await this.kv.setex(SNAPSHOT_KEY, SNAPSHOT_TTL_SECONDS, raw);
		return Buffer.byteLength(raw);
	}

	/**
	 * A random secret for UTC day `day` (days since the epoch), the same for every build of that day across workers: the
	 * follower sample's second window is placed with it, so an account keeps one verdict for the day and nobody outside
	 * can tell where the window falls.
	 */
	async getDaySeed(day: number): Promise<string> {
		const key = `feed:suggest:seed:${day}`;
		const seed = randomUUID();
		if (await this.kv.setnx(key, seed, DAY_SEED_TTL_SECONDS)) return seed;
		return (await this.kv.get(key)) ?? seed;
	}

	/**
	 * One build at a time, and at most one start per 50 s across workers (the cron runs once a minute): runs that piled
	 * up behind a busy batch lane end at once. Returns the build's token, or null. The KV client has no compare-and-set
	 * for the snapshot, so a build keeps this gate while it runs (holdBuild), and one that lost it writes no snapshot
	 * (FeedDiscoverRepository.claimBuild pattern).
	 */
	async claimBuild(): Promise<string | null> {
		const token = randomUUID();
		return (await this.kv.acquireLock(BUILD_KEY, token, BUILD_GATE_SECONDS)) ? token : null;
	}

	/** Keeps the build's gate `seconds` more; false once it lapsed and another build may hold it. */
	holdBuild(token: string, seconds = BUILD_GATE_SECONDS): Promise<boolean> {
		return this.kv.extendLock(BUILD_KEY, token, seconds);
	}

	/** After the build: the gate lasts until 50 s after its start, so a short build does not let a queued run in. */
	async endBuild(token: string, startedAtMs: number): Promise<void> {
		const leftMs = BUILD_GATE_SECONDS * 1000 - (Date.now() - startedAtMs);
		await this.holdBuild(token, Math.max(1, Math.ceil(leftMs / 1000)));
	}
}
