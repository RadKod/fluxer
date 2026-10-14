// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {Logger} from '@app/api/Logger';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import {seconds} from 'itty-time';

export interface TokenRange {
	start: bigint;
	end: bigint;
}

export const MIN_TOKEN = -(2n ** 63n);
export const MAX_TOKEN = 2n ** 63n - 1n;
const RING_SIZE = 2n ** 64n;

const LOCK_TTL_SECONDS = seconds('5 minutes');
const CHECKPOINT_TTL_SECONDS = seconds('7 days');
const RANGE_DONE = 'done';

export function splitTokenRing(n: number): Array<TokenRange> {
	if (!Number.isSafeInteger(n) || n < 1) {
		throw new Error(`Token ring needs a positive whole number of ranges, got ${n}`);
	}
	const count = BigInt(n);
	const width = RING_SIZE / count;
	const remainder = RING_SIZE % count;
	const ranges: Array<TokenRange> = [];
	let start = MIN_TOKEN;
	for (let i = 0n; i < count; i++) {
		const end = start + width + (i < remainder ? 1n : 0n) - 1n;
		ranges.push({start, end});
		start = end + 1n;
	}
	return ranges;
}

export interface TokenRangeScanOptions<T> {
	job: string;
	ranges: number;
	concurrency: number;
	page: (range: TokenRange, pageState: string | null) => Promise<{rows: Array<T>; pageState: string | null}>;
	onRows: (rows: Array<T>) => Promise<void>;
	kv: IKVProvider;
}

export async function scanByTokenRanges<T>(opts: TokenRangeScanOptions<T>): Promise<void> {
	const {job, kv} = opts;
	const lockKey = `job:${job}`;
	const lockToken = randomUUID();
	if (!(await kv.acquireLock(lockKey, lockToken, LOCK_TTL_SECONDS))) {
		Logger.debug({job}, 'Token range scan is already running elsewhere, skipping');
		return;
	}
	const ranges = splitTokenRing(opts.ranges);
	const checkpointKeys = ranges.map((_, index) => `scan:${job}:${index}`);
	let lockLost = false;
	try {
		const checkpoints = await kv.mget(...checkpointKeys);
		await mapWithConcurrency(ranges, opts.concurrency, async (range, index) => {
			let pageState = checkpoints[index] ?? null;
			if (pageState === RANGE_DONE) return;
			do {
				if (lockLost) return;
				const page = await opts.page(range, pageState);
				if (page.rows.length > 0) await opts.onRows(page.rows);
				pageState = page.pageState;
				if (!(await kv.extendLock(lockKey, lockToken, LOCK_TTL_SECONDS))) {
					lockLost = true;
					return;
				}
				await kv.setex(checkpointKeys[index]!, CHECKPOINT_TTL_SECONDS, pageState ?? RANGE_DONE);
			} while (pageState !== null);
		});
		if (lockLost) {
			Logger.warn({job}, 'Token range scan lost its job lock; the new holder resumes from the checkpoints');
			return;
		}
		await kv.del(...checkpointKeys);
	} finally {
		await kv.releaseLock(lockKey, lockToken);
	}
}
