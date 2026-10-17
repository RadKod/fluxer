// SPDX-License-Identifier: AGPL-3.0-or-later

// Spectator cheers as everyone sees them: a short feed, each person's latest cheer and a hype level that rises with
// every cheer and fades on its own. Cheers are lossy and unordered, so each client keeps its own copy; the rate
// limit applies on both ends, so a flood from one sender is cut even if its client does not hold back.

import type {BandCheerKind} from '@app/features/activities/band/BandProtocol';
import {action, makeObservable, observableRef} from 'mobx';

export const BAND_CHEER_KINDS: ReadonlyArray<BandCheerKind> = ['clap', 'fire', 'horns', 'wow'];
export const BAND_CHEER_INTERVAL_MS = 800;
// A spectator counts as cheering this long after their last cheer.
export const BAND_CHEERING_MS = 5_000;
const FEED_SIZE = 6;
const HYPE_PER_CHEER = 0.08;
const HYPE_HALF_LIFE_MS = 8_000;

export interface BandCheerEntry {
	readonly key: number;
	readonly userId: string;
	readonly kind: BandCheerKind;
	readonly at: number;
}

export function isBandCheerKind(value: unknown): value is BandCheerKind {
	return typeof value === 'string' && (BAND_CHEER_KINDS as ReadonlyArray<string>).includes(value);
}

export class BandCrowd {
	feed: ReadonlyArray<BandCheerEntry> = [];
	latestByUser: ReadonlyMap<string, BandCheerEntry> = new Map();
	private hype = 0;
	private hypeUpdatedAt = 0;
	private nextKey = 0;

	constructor() {
		makeObservable<BandCrowd, 'hype' | 'hypeUpdatedAt'>(this, {
			feed: observableRef,
			latestByUser: observableRef,
			hype: observableRef,
			hypeUpdatedAt: observableRef,
			receive: action,
			reset: action,
		});
	}

	canCheer(userId: string, now: number): boolean {
		const last = this.latestByUser.get(userId);
		return !last || now - last.at >= BAND_CHEER_INTERVAL_MS;
	}

	// False when the sender is over the rate limit; the cheer is then dropped.
	receive(userId: string, kind: BandCheerKind, now: number): boolean {
		if (!this.canCheer(userId, now)) return false;
		const entry: BandCheerEntry = {key: ++this.nextKey, userId, kind, at: now};
		this.feed = [...this.feed, entry].slice(-FEED_SIZE);
		this.latestByUser = new Map(this.latestByUser).set(userId, entry);
		this.hype = Math.min(1, this.hypeLevel(now) + HYPE_PER_CHEER);
		this.hypeUpdatedAt = now;
		return true;
	}

	isCheering(userId: string, now: number): boolean {
		const last = this.latestByUser.get(userId);
		return last !== undefined && now - last.at < BAND_CHEERING_MS;
	}

	// 0..1, halving every eight seconds without cheers.
	hypeLevel(now: number): number {
		if (this.hype === 0) return 0;
		const elapsed = Math.max(0, now - this.hypeUpdatedAt);
		return this.hype * 0.5 ** (elapsed / HYPE_HALF_LIFE_MS);
	}

	reset(): void {
		this.feed = [];
		this.latestByUser = new Map();
		this.hype = 0;
		this.hypeUpdatedAt = 0;
	}
}
