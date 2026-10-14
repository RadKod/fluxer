// SPDX-License-Identifier: AGPL-3.0-or-later

import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {
	COUNTER_PARTITIONS,
	type CounterFlusher,
	counterDirtyKey,
	counterInflightKey,
	counterKey,
	counterPartition,
	KVCounterService,
} from '@app/api/infrastructure/KVCounterService';
import {startDockerContainer} from '@app/api/test/DockerTestContainer';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {computeHashSlot} from '@pkgs/kv_client/src/KVHashSlots';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const NS = 'test_counter';
const FLUSHED_TTL_SECONDS = 86_400;
const dockerAvailable = spawnSync('docker', ['version'], {stdio: 'ignore'}).status === 0;

class FakeStatsFlusher implements CounterFlusher {
	readonly namespace = NS;
	readonly stats = new Map<string, number>();
	readonly rows = new Map<string, number>();
	readonly flushes: Array<{id: string; value: number}> = [];
	failNextFlush = false;
	failFlushOf: string | null = null;
	holdNextFlush: Promise<void> | null = null;
	heldFlushStarted = false;

	baseReads = 0;
	private activeBaseReads = 0;
	peakBaseReads = 0;

	async readBase(id: string): Promise<number> {
		this.baseReads++;
		this.activeBaseReads++;
		this.peakBaseReads = Math.max(this.peakBaseReads, this.activeBaseReads);
		await new Promise((resolve) => setTimeout(resolve, 0));
		this.activeBaseReads--;
		return this.stats.get(id) ?? 0;
	}

	async flush(id: string, value: number): Promise<void> {
		if (this.failNextFlush || this.failFlushOf === id) {
			this.failNextFlush = false;
			throw new Error('stats write failed');
		}
		const hold = this.holdNextFlush;
		if (hold) {
			this.holdNextFlush = null;
			this.heldFlushStarted = true;
			await hold;
		}
		this.flushes.push({id, value});
		this.stats.set(id, value);
	}

	async recount(id: string): Promise<number> {
		return this.rows.get(id) ?? this.stats.get(id) ?? 0;
	}
}

const VIEW_NS = 'test_view_counter';

class DirtySetFlusher implements CounterFlusher {
	readonly namespace = VIEW_NS;
	readonly dirtySet = 'views';
	readonly stats = new Map<string, number>();

	async readBase(id: string): Promise<number> {
		return this.stats.get(id) ?? 0;
	}

	async flush(id: string, value: number): Promise<void> {
		this.stats.set(id, value);
	}

	async recount(id: string): Promise<number> {
		return this.stats.get(id) ?? 0;
	}
}

async function flushAll(service: KVCounterService): Promise<number> {
	let flushed = 0;
	for (let partition = 0; partition < COUNTER_PARTITIONS; partition++) {
		flushed += await service.flushPartition(partition, 1000);
	}
	return flushed;
}

async function wipe(kv: IKVProvider): Promise<void> {
	const keys = await kv.scan('*', 100_000);
	if (keys.length > 0) {
		await kv.del(...keys);
	}
}

function counterContract(label: string, createKv: () => IKVProvider): void {
	describe(`KV counter contract (${label})`, () => {
		let kv: IKVProvider;
		let flusher: FakeStatsFlusher;
		let service: KVCounterService;

		beforeEach(async () => {
			kv = createKv();
			await wipe(kv);
			flusher = new FakeStatsFlusher();
			service = new KVCounterService(kv);
			service.register(flusher);
		});

		it('returns nil for a missing counter without a base and leaves no trace', async () => {
			const key = counterKey(NS, 'a');
			const dirty = counterDirtyKey(counterPartition(NS, 'a'));
			expect(await kv.counterAdd(key, dirty, `${NS}:a`, 1, null)).toBeNull();
			expect(await kv.exists(key)).toBe(0);
			expect(await kv.sismember(dirty, `${NS}:a`)).toBe(0);
		});

		it('seeds from the base, applies the delta, persists and marks dirty in one step', async () => {
			const key = counterKey(NS, 'a');
			const dirty = counterDirtyKey(counterPartition(NS, 'a'));
			expect(await kv.counterAdd(key, dirty, `${NS}:a`, 3, 40)).toBe(43);
			expect(await kv.ttl(key)).toBe(-1);
			expect(await kv.sismember(dirty, `${NS}:a`)).toBe(1);
			expect(await kv.counterAdd(key, dirty, `${NS}:a`, -5, 1000)).toBe(38);
		});

		it('applies negative deltas on top of the stored base', async () => {
			flusher.stats.set('a', 10);
			expect(await service.add(NS, 'a', -3)).toBe(7);
			expect(await service.add(NS, 'a', 5)).toBe(12);
		});

		it('seeds a missing counter exactly once under concurrent adds', async () => {
			flusher.stats.set('a', 100);
			await Promise.all(Array.from({length: 50}, async () => service.add(NS, 'a', 1)));
			expect(await service.get(NS, 'a')).toBe(150);
		});

		it('flushes each dirty counter once with its latest value', async () => {
			for (let i = 0; i < 3; i++) await service.add(NS, 'a', 1);
			for (let i = 0; i < 2; i++) await service.add(NS, 'b', 1);
			expect(await flushAll(service)).toBe(2);
			expect(flusher.flushes.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
				{id: 'a', value: 3},
				{id: 'b', value: 2},
			]);
			expect(await flushAll(service)).toBe(0);
		});

		it('gives a flushed counter a TTL that the next add removes', async () => {
			await service.add(NS, 'a', 1);
			await flushAll(service);
			const ttl = await kv.ttl(counterKey(NS, 'a'));
			expect(ttl).toBeGreaterThan(0);
			expect(ttl).toBeLessThanOrEqual(FLUSHED_TTL_SECONDS);
			await service.add(NS, 'a', 1);
			expect(await kv.ttl(counterKey(NS, 'a'))).toBe(-1);
		});

		it('reads the stored value for a missing counter without writing it to KV', async () => {
			flusher.stats.set('a', 42);
			expect(await service.get(NS, 'a')).toBe(42);
			expect(await service.getMany(NS, ['a', 'missing'])).toEqual([42, 0]);
			expect(await kv.exists(counterKey(NS, 'a'))).toBe(0);
		});

		it('uses stored values the caller already has for counters missing from KV', async () => {
			await service.add(NS, 'b', 1);
			flusher.baseReads = 0;
			expect(await service.getMany(NS, ['a', 'b', 'c'], [40, 99, 7])).toEqual([40, 1, 7]);
			expect(flusher.baseReads).toBe(0);
		});

		it('reads missing stored values with bounded concurrency', async () => {
			const ids = Array.from({length: 100}, (_, index) => `m${index}`);
			expect(await service.getMany(NS, ids)).toEqual(ids.map(() => 0));
			expect(flusher.baseReads).toBe(100);
			expect(flusher.peakBaseReads).toBeLessThanOrEqual(16);
		});

		it('continues from the stored value after the KV store is wiped', async () => {
			for (let i = 0; i < 7; i++) await service.add(NS, 'a', 1);
			await flushAll(service);
			await wipe(kv);
			await Promise.all(Array.from({length: 50}, async () => service.add(NS, 'a', 1)));
			await flushAll(service);
			expect(flusher.stats.get('a')).toBe(57);
		});

		it('keeps a failing counter dirty, flushes the others and does not fail the flush', async () => {
			const ids = Array.from({length: 100_000}, (_, index) => `id${index}`);
			const failing = ids.find((id) => counterPartition(NS, id) === counterPartition(NS, 'a') && id !== 'a')!;
			for (const id of ['a', failing]) await service.add(NS, id, 1);
			flusher.failFlushOf = failing;
			expect(await flushAll(service)).toBe(1);
			expect(flusher.stats.get('a')).toBe(1);
			expect(flusher.stats.has(failing)).toBe(false);
			expect(await kv.sismember(counterDirtyKey(counterPartition(NS, failing)), `${NS}:${failing}`)).toBe(1);
			flusher.failFlushOf = null;
			expect(await flushAll(service)).toBe(1);
			expect(flusher.stats.get(failing)).toBe(1);
		});

		it('puts back a counter of a namespace this process does not know without failing', async () => {
			const member = 'other_ns:x';
			const dirty = counterDirtyKey(counterPartition('other_ns', 'x'));
			await kv.counterAdd(counterKey('other_ns', 'x'), dirty, member, 1, 0);
			await service.add(NS, 'a', 1);
			expect(await flushAll(service)).toBe(1);
			expect(await kv.sismember(dirty, member)).toBe(1);
		});

		it('claims dirty members into the in-flight set and puts unsettled ones back on the next claim', async () => {
			const dirty = counterDirtyKey(3);
			const inflight = counterInflightKey(3);
			await kv.sadd(dirty, 'n:a', 'n:b', 'n:c');
			const first = await kv.counterClaim(dirty, inflight, 2);
			expect(first).toHaveLength(2);
			expect((await kv.smembers(inflight)).sort()).toEqual([...first].sort());
			expect(await kv.scard(dirty)).toBe(1);
			const second = await kv.counterClaim(dirty, inflight, 10);
			expect(second.sort()).toEqual(['n:a', 'n:b', 'n:c']);
			expect(await kv.scard(dirty)).toBe(0);
			expect(await kv.scard(inflight)).toBe(3);
		});

		it('does not lose a dirty mark when the flushing process dies mid-flush', async () => {
			await service.add(NS, 'a', 3);
			flusher.holdNextFlush = new Promise<void>(() => {});
			void flushAll(service);
			while (!flusher.heldFlushStarted) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			await kv.del(`job:flushCounters:{${counterPartition(NS, 'a')}}`);
			expect(await flushAll(service)).toBe(1);
			expect(flusher.stats.get('a')).toBe(3);
			expect(await kv.scard(counterInflightKey(counterPartition(NS, 'a')))).toBe(0);
		});

		it('keeps a counter with its own dirty set out of the shared dirty set', async () => {
			const views = new DirtySetFlusher();
			service.register(views);
			const partition = counterPartition(VIEW_NS, 'a');
			const member = `${VIEW_NS}:a`;
			await service.add(VIEW_NS, 'a', 2);
			expect(await kv.sismember(counterDirtyKey(partition), member)).toBe(0);
			expect(await kv.sismember(counterDirtyKey(partition, 'views'), member)).toBe(1);

			expect(await flushAll(service)).toBe(0);
			expect(views.stats.size).toBe(0);

			expect(await service.flushPartition(partition, 1000, 'views')).toBe(1);
			expect(views.stats.get('a')).toBe(2);
			expect(await kv.scard(counterDirtyKey(partition, 'views'))).toBe(0);
		});

		it('flushes a dirty set only under its own lock and keys', async () => {
			const views = new DirtySetFlusher();
			service.register(views);
			const partition = counterPartition(VIEW_NS, 'a');
			const member = `${VIEW_NS}:a`;
			expect(counterDirtyKey(partition, 'views')).toBe(`counter:dirty:views:{${partition}}`);
			expect(counterInflightKey(partition, 'views')).toBe(`counter:inflight:views:{${partition}}`);
			expect(computeHashSlot(counterInflightKey(partition, 'views'))).toBe(computeHashSlot(counterDirtyKey(partition)));
			await service.add(VIEW_NS, 'a', 4);
			// Left in flight by a views flush that died: only the next claim of the views set puts it back.
			await kv.srem(counterDirtyKey(partition, 'views'), member);
			await kv.sadd(counterInflightKey(partition, 'views'), member);
			expect(await service.flushPartition(partition, 1000)).toBe(0);
			expect(await kv.sismember(counterInflightKey(partition, 'views'), member)).toBe(1);

			const viewsLock = `job:flushCounters:views:{${partition}}`;
			expect(await kv.acquireLock(viewsLock, 'other', 60)).toBe(true);
			expect(await service.flushPartition(partition, 1000, 'views')).toBe(0);
			await kv.releaseLock(viewsLock, 'other');

			const sharedLock = `job:flushCounters:{${partition}}`;
			expect(await kv.acquireLock(sharedLock, 'other', 60)).toBe(true);
			expect(await service.flushPartition(partition, 1000, 'views')).toBe(1);
			await kv.releaseLock(sharedLock, 'other');
			expect(views.stats.get('a')).toBe(4);
			expect(await kv.scard(counterInflightKey(partition, 'views'))).toBe(0);
		});

		it('rebuilds a counter from a recount', async () => {
			await service.add(NS, 'a', 5);
			flusher.rows.set('a', 9);
			expect(await service.rebuild(NS, 'a')).toBe(9);
			expect(await service.add(NS, 'a', 1)).toBe(10);
			await flushAll(service);
			expect(flusher.stats.get('a')).toBe(10);
		});

		it('repairs a drifted counter through the counter itself so the next flush keeps the repair', async () => {
			flusher.stats.set('a', 10);
			await service.add(NS, 'a', 5);
			await flushAll(service);
			expect(await service.reconcile(NS, 'a', async () => 10)).toBe(10);
			expect(await service.get(NS, 'a')).toBe(10);
			await flushAll(service);
			expect(flusher.stats.get('a')).toBe(10);
		});

		it('skips a repair when the counter moved during the recount', async () => {
			flusher.stats.set('a', 10);
			const value = await service.reconcile(NS, 'a', async () => {
				await service.add(NS, 'a', 1);
				return 3;
			});
			expect(value).toBe(11);
			expect(await service.get(NS, 'a')).toBe(11);
		});

		it('rebuilds without losing to a flush that read the old value', async () => {
			await service.add(NS, 'a', 5);
			let release!: () => void;
			flusher.holdNextFlush = new Promise<void>((resolve) => {
				release = resolve;
			});
			const pendingFlush = flushAll(service);
			while (!flusher.heldFlushStarted) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			flusher.rows.set('a', 9);
			expect(await service.rebuild(NS, 'a')).toBe(9);
			release();
			await pendingFlush;
			await flushAll(service);
			expect(flusher.stats.get('a')).toBe(9);
			expect(await service.get(NS, 'a')).toBe(9);
		});
	});
}

counterContract('mock', () => new MockKVProvider());

describe.skipIf(!dockerAvailable)('valkey', () => {
	const container = `fluxer-kvcounter-${process.pid.toString(36)}-${Date.now().toString(36)}`;
	let client: KVClient | null = null;

	beforeAll(async () => {
		const port = await freePort();
		startDockerContainer([
			'run',
			'-d',
			'--name',
			container,
			'-p',
			`127.0.0.1:${port}:6379`,
			'valkey/valkey:9.1-alpine',
		]);
		for (let attempt = 0; attempt < 120; attempt++) {
			const probe = spawnSync('docker', ['exec', container, 'valkey-cli', 'ping'], {encoding: 'utf8'});
			if (probe.stdout?.trim() === 'PONG') break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		client = new KVClient(`redis://127.0.0.1:${port}`);
	}, 300_000);

	afterAll(() => {
		client?.close();
		spawnSync('docker', ['rm', '-f', container], {stdio: 'ignore'});
	});

	counterContract('valkey', () => {
		if (!client) throw new Error('valkey client is not ready');
		return client;
	});
});

describe('KV counter keys', () => {
	it('spreads counters over 1024 partitions so the counter slots can span a large cluster', () => {
		expect(COUNTER_PARTITIONS).toBe(1024);
	});

	it('keeps every counter key in the same cluster slot as its dirty set', () => {
		const seen = new Set<number>();
		for (let i = 0; i < 20_000; i++) {
			const id = String(1_000_000_000_000_000n + BigInt(i));
			const partition = counterPartition(NS, id);
			expect(partition).toBeGreaterThanOrEqual(0);
			expect(partition).toBeLessThan(COUNTER_PARTITIONS);
			seen.add(partition);
			const key = counterKey(NS, id);
			const dirty = counterDirtyKey(partition);
			expect(key).toContain(`{${partition}}`);
			expect(dirty).toContain(`{${partition}}`);
			expect(computeHashSlot(key)).toBe(computeHashSlot(dirty));
			expect(computeHashSlot(counterInflightKey(partition))).toBe(computeHashSlot(dirty));
		}
		expect(seen.size).toBe(COUNTER_PARTITIONS);
	});

	it('refuses a cross-slot counter write like a cluster does', async () => {
		const kv = new MockKVProvider();
		await expect(kv.counterAdd(counterKey(NS, 'a'), 'counter:dirty:unrelated', `${NS}:a`, 1, 0)).rejects.toThrow(
			/CROSSSLOT/,
		);
		await expect(kv.counterClaim(counterDirtyKey(0), 'counter:inflight:unrelated', 1)).rejects.toThrow(/CROSSSLOT/);
	});

	it('refuses a dirty set name other than a-z and _', () => {
		const service = new KVCounterService(new MockKVProvider());
		const flusher = (namespace: string, dirtySet: string): CounterFlusher => ({
			namespace,
			dirtySet,
			readBase: async () => 0,
			flush: async () => {},
			recount: async () => 0,
		});
		for (const [index, dirtySet] of ['', 'Views', 'views1', 'views:x', '{7}', 'vi ews'].entries()) {
			expect(() => service.register(flusher(`bad_${index}`, dirtySet))).toThrow(/dirty set/);
		}
		expect(() => service.register(flusher('good', 'feed_views'))).not.toThrow();
	});
});

class GatedFlusher implements CounterFlusher {
	readonly namespace = NS;
	readonly stats = new Map<string, number>();
	private readonly gates = new Map<string, Array<{enter: () => void; opened: Promise<void>}>>();

	/** Holds the next not yet gated flush of `id` until `open` is called. */
	gate(id: string): {entered: Promise<void>; open: () => void} {
		let enter!: () => void;
		let open!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		this.gates.set(id, [...(this.gates.get(id) ?? []), {enter, opened}]);
		return {entered, open};
	}

	async readBase(): Promise<number> {
		return 0;
	}

	async flush(id: string, value: number): Promise<void> {
		const gate = this.gates.get(id)?.shift();
		if (gate) {
			gate.enter();
			await gate.opened;
		}
		this.stats.set(id, value);
	}

	async recount(id: string): Promise<number> {
		return this.stats.get(id) ?? 0;
	}
}

function idsInOnePartition(count: number): Array<string> {
	const partition = counterPartition(NS, 'x0');
	const ids: Array<string> = [];
	for (let i = 0; ids.length < count; i++) {
		if (counterPartition(NS, `x${i}`) === partition) ids.push(`x${i}`);
	}
	return ids;
}

describe('KV counter flush lock', () => {
	let now: number;
	let kv: MockKVProvider;
	let flusher: GatedFlusher;
	let service: KVCounterService;

	beforeEach(() => {
		now = Date.now();
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		kv = new MockKVProvider();
		flusher = new GatedFlusher();
		service = new KVCounterService(kv);
		service.register(flusher);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('keeps the partition lock through a batch that outlasts the lock TTL', async () => {
		const [a, b] = idsInOnePartition(2) as [string, string];
		const partition = counterPartition(NS, a);
		await service.add(NS, a, 1);
		await service.add(NS, b, 2);
		const gateA = flusher.gate(a);
		const gateB = flusher.gate(b);
		const first = service.flushPartition(partition, 1000);
		await Promise.all([gateA.entered, gateB.entered]);

		now += 30_000;
		gateA.open();
		while ((await kv.sismember(counterInflightKey(partition), `${NS}:${a}`)) === 1) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		now += 40_000;
		expect(await service.flushPartition(partition, 1000)).toBe(0);

		gateB.open();
		expect(await first).toBe(2);
		expect(flusher.stats).toEqual(
			new Map([
				[a, 1],
				[b, 2],
			]),
		);
		expect(await kv.scard(counterInflightKey(partition))).toBe(0);
		expect(await kv.scard(counterDirtyKey(partition))).toBe(0);
	});

	it('stops touching the partition once its lock is lost, so the next holder keeps the dirty mark', async () => {
		const [a] = idsInOnePartition(1) as [string];
		const partition = counterPartition(NS, a);
		await service.add(NS, a, 3);
		const firstGate = flusher.gate(a);
		const secondGate = flusher.gate(a);
		const first = service.flushPartition(partition, 1000);
		await firstGate.entered;

		now += 61_000;
		await service.add(NS, a, 1);
		void service.flushPartition(partition, 1000);
		await secondGate.entered;
		firstGate.open();
		expect(await first).toBe(0);

		// The second holder dies mid-flush; once its lock runs out the next claim still finds the member.
		now += 61_000;
		expect(await service.flushPartition(partition, 1000)).toBe(1);
		expect(flusher.stats.get(a)).toBe(4);
		expect(await kv.scard(counterInflightKey(partition))).toBe(0);
	});
});

describe('KV counter subject lock', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('holds the subject lock for as long as the change runs and stops renewing after it', async () => {
		vi.useFakeTimers();
		const kv = new MockKVProvider();
		const service = new KVCounterService(kv);
		let finish!: () => void;
		const slow = service.withSubjectLock(NS, 'g', 'u', async () => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		await vi.advanceTimersByTimeAsync(120_000);

		let contenderRan = false;
		const contender = service.withSubjectLock(NS, 'g', 'u', async () => {
			contenderRan = true;
		});
		const contenderRejected = expect(contender).rejects.toBeInstanceOf(ResourceLockedError);
		await vi.advanceTimersByTimeAsync(6_000);
		await contenderRejected;
		expect(contenderRan).toBe(false);

		finish();
		await slow;
		expect(kv.acquireLockSpy.mock.calls[0]![2]).toBeGreaterThanOrEqual(30);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('backs off to at most a quarter second between tries while the subject lock is held', async () => {
		vi.useFakeTimers();
		const kv = new MockKVProvider();
		const service = new KVCounterService(kv);
		let finish!: () => void;
		const holder = service.withSubjectLock(NS, 'g', 'u', async () => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		await vi.advanceTimersByTimeAsync(0);
		const triesBefore = kv.acquireLockSpy.mock.calls.length;

		const contender = service.withSubjectLock(NS, 'g', 'u', async () => {});
		const contenderRejected = expect(contender).rejects.toBeInstanceOf(ResourceLockedError);
		await vi.advanceTimersByTimeAsync(6_000);
		await contenderRejected;

		// 5 s of waiting: 20 ms polling made about 250 tries; doubling from 20 ms up to 250 ms makes about 25 to 45.
		const tries = kv.acquireLockSpy.mock.calls.length - triesBefore;
		expect(tries).toBeGreaterThanOrEqual(15);
		expect(tries).toBeLessThanOrEqual(50);
		finish();
		await holder;
	});
});

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (typeof address === 'string' || address === null) {
				reject(new Error('no port'));
				return;
			}
			const port = address.port;
			server.close(() => resolve(port));
		});
	});
}
