// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {Logger} from '@app/api/Logger';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

// TEMPORARY: 1024 partitions cap counter traffic at 1024 KV primaries (a cluster tops out near 1000 nodes); raising it
// again needs a full flush first.
export const COUNTER_PARTITIONS = 1024;
const FLUSHED_COUNTER_TTL_SECONDS = 86_400;
const FLUSH_LOCK_TTL_SECONDS = 60;
// Extended by time, not by member count: on a slow store a fixed number of members can take longer than the TTL.
const FLUSH_LOCK_EXTEND_INTERVAL_MS = 20_000;
const FLUSH_CONCURRENCY = 8;
const BASE_READ_CONCURRENCY = 16;
// Renewed while the change runs, since a change is several store calls whose timeouts and retries add up.
const SUBJECT_LOCK_TTL_SECONDS = 30;
const SUBJECT_LOCK_EXTEND_INTERVAL_MS = 10_000;
const SUBJECT_LOCK_MAX_WAIT_MS = 5000;
const SUBJECT_LOCK_RETRY_DELAY_MS = 20;
const SUBJECT_LOCK_RETRY_MAX_DELAY_MS = 250;

export interface CounterFlusher {
	namespace: string;
	// a namespace with its own dirty set is flushed only by a job that names the set, never
	// by flushCounters, so its volume cannot eat the shared budget. Omitted: the shared set.
	dirtySet?: string;
	readBase(id: string): Promise<number>;
	flush(id: string, value: number): Promise<void>;
	recount(id: string): Promise<number>;
}

function fnv1a(input: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < input.length; index++) {
		hash ^= input.charCodeAt(index) & 0xff;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

export function counterPartition(namespace: string, id: string): number {
	return fnv1a(`${namespace}:${id}`) % COUNTER_PARTITIONS;
}

export function counterKey(namespace: string, id: string): string {
	return `counter:{${counterPartition(namespace, id)}}:${namespace}:${id}`;
}

const setPart = (dirtySet?: string) => (dirtySet ? `${dirtySet}:` : '');

export function counterDirtyKey(partition: number, dirtySet?: string): string {
	return `counter:dirty:${setPart(dirtySet)}{${partition}}`;
}

export function counterInflightKey(partition: number, dirtySet?: string): string {
	return `counter:inflight:${setPart(dirtySet)}{${partition}}`;
}

function parseCounterValue(raw: string): number {
	const value = Number(raw);
	if (!Number.isSafeInteger(value)) {
		throw new Error(`Invalid KV counter value: ${raw}`);
	}
	return value;
}

export class KVCounterService {
	private readonly flushers = new Map<string, CounterFlusher>();

	constructor(private readonly kv: IKVProvider) {}

	register(flusher: CounterFlusher): void {
		if (flusher.namespace.includes(':') || this.flushers.has(flusher.namespace)) {
			throw new Error(`Invalid or duplicate counter namespace: ${flusher.namespace}`);
		}
		if (flusher.dirtySet !== undefined && !/^[a-z_]+$/.test(flusher.dirtySet)) {
			throw new Error(`Invalid counter dirty set for ${flusher.namespace}: ${flusher.dirtySet}`);
		}
		this.flushers.set(flusher.namespace, flusher);
	}

	async add(namespace: string, id: string, delta: number): Promise<number> {
		const flusher = this.requireFlusher(namespace);
		const key = counterKey(namespace, id);
		const dirtyKey = counterDirtyKey(counterPartition(namespace, id), flusher.dirtySet);
		const member = `${namespace}:${id}`;
		const value = await this.kv.counterAdd(key, dirtyKey, member, delta, null);
		if (value !== null) {
			return value;
		}
		const base = await flusher.readBase(id);
		const seeded = await this.kv.counterAdd(key, dirtyKey, member, delta, base);
		if (seeded === null) {
			throw new Error(`KV counter ${member} was not seeded`);
		}
		return seeded;
	}

	/**
	 * Serializes check-then-write changes of one counted subject (for example one guild member), so the row
	 * check, the row write and the counter delta happen once even when the same change races itself.
	 */
	async withSubjectLock<T>(namespace: string, id: string, subject: string, fn: () => Promise<T>): Promise<T> {
		const lockKey = `counter:lock:${namespace}:${id}:${subject}`;
		const token = randomUUID();
		const deadline = Date.now() + SUBJECT_LOCK_MAX_WAIT_MS;
		let retryDelayMs = SUBJECT_LOCK_RETRY_DELAY_MS;
		while (!(await this.kv.acquireLock(lockKey, token, SUBJECT_LOCK_TTL_SECONDS))) {
			if (Date.now() >= deadline) {
				throw new ResourceLockedError();
			}
			// Doubling up to a quarter second keeps a long wait to a few dozen KV calls; the random half stops waiters
			// that lost together from retrying together.
			const waitMs = retryDelayMs / 2 + Math.random() * (retryDelayMs / 2);
			await new Promise((resolve) => setTimeout(resolve, waitMs));
			retryDelayMs = Math.min(retryDelayMs * 2, SUBJECT_LOCK_RETRY_MAX_DELAY_MS);
		}
		const renewal = setInterval(() => {
			this.kv.extendLock(lockKey, token, SUBJECT_LOCK_TTL_SECONDS).then(
				(held) => {
					if (!held) Logger.warn({lockKey}, 'Lost a counter subject lock while its change was running');
				},
				(error: unknown) => Logger.warn({error, lockKey}, 'Failed to renew a counter subject lock'),
			);
		}, SUBJECT_LOCK_EXTEND_INTERVAL_MS);
		try {
			return await fn();
		} finally {
			clearInterval(renewal);
			await this.kv.releaseLock(lockKey, token).catch((error: unknown) => {
				Logger.warn({error, lockKey}, 'Failed to release a counter subject lock; it expires on its own');
			});
		}
	}

	async get(namespace: string, id: string): Promise<number> {
		const flusher = this.requireFlusher(namespace);
		const raw = await this.kv.get(counterKey(namespace, id));
		return raw === null ? await flusher.readBase(id) : parseCounterValue(raw);
	}

	/** `storedValues[i]`, when given, is the caller's already-read stored value for `ids[i]` (used on a KV miss). */
	async getMany(namespace: string, ids: Array<string>, storedValues?: Array<number>): Promise<Array<number>> {
		const flusher = this.requireFlusher(namespace);
		const raws = await this.kv.mget(...ids.map((id) => counterKey(namespace, id)));
		return await mapWithConcurrency(raws, BASE_READ_CONCURRENCY, async (raw, index) => {
			if (raw !== null) {
				return parseCounterValue(raw);
			}
			return storedValues?.[index] ?? (await flusher.readBase(ids[index]!));
		});
	}

	async flushPartition(partition: number, max: number, dirtySet?: string): Promise<number> {
		const lockKey = `job:flushCounters:${setPart(dirtySet)}{${partition}}`;
		const token = randomUUID();
		if (!(await this.kv.acquireLock(lockKey, token, FLUSH_LOCK_TTL_SECONDS))) {
			return 0;
		}
		let lockCheckedAt = Date.now();
		let lockHeld = true;
		// Once the lock cannot be extended another flusher may own the partition, so this batch stops writing and
		// leaves its unsettled members in the in-flight set for that flusher's claim to put back.
		const holdsLock = async (): Promise<boolean> => {
			if (lockHeld && Date.now() - lockCheckedAt >= FLUSH_LOCK_EXTEND_INTERVAL_MS) {
				lockCheckedAt = Date.now();
				lockHeld = await this.kv.extendLock(lockKey, token, FLUSH_LOCK_TTL_SECONDS);
			}
			return lockHeld;
		};
		try {
			// Claimed members stay in the in-flight set until settled; the next claim of this partition (under the
			// same lock) puts leftovers of a crashed flush back into the dirty set.
			const dirtyKey = counterDirtyKey(partition, dirtySet);
			const inflightKey = counterInflightKey(partition, dirtySet);
			const members = await this.kv.counterClaim(dirtyKey, inflightKey, max);
			let flushed = 0;
			await mapWithConcurrency(members, FLUSH_CONCURRENCY, async (member) => {
				if (!(await holdsLock())) {
					return;
				}
				let settled = false;
				try {
					settled = await this.flushMember(member, holdsLock);
				} catch (error) {
					Logger.warn({error, member}, 'Failed to flush a KV counter; it stays dirty');
				}
				if (!(await holdsLock())) {
					return;
				}
				if (settled) {
					await this.kv.srem(inflightKey, member);
					flushed++;
					return;
				}
				await this.kv.sadd(dirtyKey, member);
				await this.kv.srem(inflightKey, member);
			});
			return flushed;
		} finally {
			await this.kv.releaseLock(lockKey, token);
		}
	}

	async rebuild(namespace: string, id: string): Promise<number> {
		const flusher = this.requireFlusher(namespace);
		return await this.reconcile(namespace, id, async () => flusher.recount(id));
	}

	/**
	 * Repairs drift found by a recount. The fix goes in as a delta through the counter (never a direct stored
	 * write or a key delete), so concurrent adds survive and the normal flush carries it to Cassandra. Skipped
	 * when the counter moved during the recount; returns the live value.
	 */
	async reconcile(namespace: string, id: string, count: () => Promise<number>): Promise<number> {
		// TEMPORARY: a change caught between its row write and its counter delta during the recount can still leave ±1; the next repair fixes it.
		const before = await this.get(namespace, id);
		const actual = await count();
		const after = await this.get(namespace, id);
		if (before !== after || actual === before) {
			return after;
		}
		return await this.add(namespace, id, actual - before);
	}

	/**
	 * Returns false, without an error, for a namespace this process has no flusher for (for example mid-deploy) or
	 * when the partition lock was lost before the write.
	 */
	private async flushMember(member: string, holdsLock: () => Promise<boolean>): Promise<boolean> {
		const separator = member.indexOf(':');
		const namespace = member.slice(0, separator);
		const id = member.slice(separator + 1);
		const flusher = this.flushers.get(namespace);
		if (!flusher) {
			return false;
		}
		const key = counterKey(namespace, id);
		const raw = await this.kv.get(key);
		if (!(await holdsLock())) {
			return false;
		}
		if (raw !== null) {
			await flusher.flush(id, parseCounterValue(raw));
			await this.kv.expire(key, FLUSHED_COUNTER_TTL_SECONDS);
		}
		return true;
	}

	private requireFlusher(namespace: string): CounterFlusher {
		const flusher = this.flushers.get(namespace);
		if (!flusher) {
			throw new Error(`No counter flusher registered for namespace ${namespace}`);
		}
		return flusher;
	}
}
