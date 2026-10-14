// SPDX-License-Identifier: AGPL-3.0-or-later

import {createRequire} from 'node:module';
import {createUserID} from '@app/api/BrandedTypes';
import {upsertOne} from '@app/api/database/CassandraQueryExecution';
import {
	MAX_TOKEN,
	MIN_TOKEN,
	scanByTokenRanges,
	splitTokenRing,
	type TokenRange,
} from '@app/api/database/TokenRangeScan';
import {EMPTY_USER_ROW} from '@app/api/database/types/UserTypes';
import {Users} from '@app/api/Tables';
import {UserDataRepository} from '@app/api/user/repositories/account/crud/UserDataRepository';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {describe, expect, it, vi} from 'vitest';

const RING_SIZE = 2n ** 64n;
const PAGE_SIZE = 10;

interface FakeRow {
	id: number;
	token: bigint;
}

function fakeRows(count: number): Array<FakeRow> {
	const rows: Array<FakeRow> = [
		{id: 0, token: MIN_TOKEN},
		{id: 1, token: MAX_TOKEN},
	];
	for (let id = 2; id < count; id++) {
		rows.push({id, token: MIN_TOKEN + (RING_SIZE * BigInt(id)) / BigInt(count)});
	}
	return rows;
}

function fakePage(rows: ReadonlyArray<FakeRow>) {
	return async (range: TokenRange, pageState: string | null) => {
		const inRange = rows
			.filter((row) => row.token >= range.start && row.token <= range.end)
			.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
		const offset = pageState === null ? 0 : Number(pageState);
		const next = offset + PAGE_SIZE;
		return {rows: inRange.slice(offset, next), pageState: next < inRange.length ? String(next) : null};
	};
}

function sortedIds(ids: Iterable<number>): Array<number> {
	return [...ids].sort((a, b) => a - b);
}

describe('splitTokenRing', () => {
	it.each([1, 7, 64])('covers the whole Murmur3 ring with %i contiguous, non-overlapping ranges', (n) => {
		const ranges = splitTokenRing(n);
		expect(ranges).toHaveLength(n);
		expect(ranges[0]!.start).toBe(-(2n ** 63n));
		expect(ranges[n - 1]!.end).toBe(2n ** 63n - 1n);
		let covered = 0n;
		for (let i = 0; i < n; i++) {
			const range = ranges[i]!;
			expect(range.start <= range.end).toBe(true);
			if (i > 0) expect(range.start).toBe(ranges[i - 1]!.end + 1n);
			covered += range.end - range.start + 1n;
		}
		expect(covered).toBe(RING_SIZE);
	});

	it.each([0, -1, 1.5, Number.NaN])('rejects %s ranges', (n) => {
		expect(() => splitTokenRing(n)).toThrow();
	});
});

describe('scanByTokenRanges', () => {
	it.each([1, 7, 64])('hands every row to onRows exactly once across %i ranges', async (ranges) => {
		const kv = new MockKVProvider();
		const rows = fakeRows(500);
		const seen: Array<number> = [];
		await scanByTokenRanges<FakeRow>({
			job: 'exactly-once',
			ranges,
			concurrency: 4,
			kv,
			page: fakePage(rows),
			onRows: async (page) => {
				seen.push(...page.map((row) => row.id));
			},
		});
		expect(sortedIds(seen)).toEqual(sortedIds(rows.map((row) => row.id)));
		expect(await kv.get('job:exactly-once')).toBeNull();
		expect(await kv.mget(...Array.from({length: ranges}, (_, i) => `scan:exactly-once:${i}`))).toEqual(
			Array.from({length: ranges}, () => null),
		);
	});

	it('resumes an interrupted scan from the range checkpoints', async () => {
		const kv = new MockKVProvider();
		const rows = fakeRows(100);
		const page = fakePage(rows);
		const firstRun = new Set<number>();
		let calls = 0;
		await expect(
			scanByTokenRanges<FakeRow>({
				job: 'resume',
				ranges: 2,
				concurrency: 1,
				kv,
				page,
				onRows: async (batch) => {
					calls++;
					if (calls === 3) throw new Error('worker crashed');
					for (const row of batch) firstRun.add(row.id);
				},
			}),
		).rejects.toThrow('worker crashed');
		expect(firstRun.size).toBe(2 * PAGE_SIZE);
		expect(await kv.get('scan:resume:0')).toBe(String(2 * PAGE_SIZE));
		expect(await kv.get('scan:resume:1')).toBeNull();
		expect(await kv.get('job:resume')).toBeNull();

		const secondRun = new Set<number>();
		const pageSpy = vi.fn(page);
		await scanByTokenRanges<FakeRow>({
			job: 'resume',
			ranges: 2,
			concurrency: 1,
			kv,
			page: pageSpy,
			onRows: async (batch) => {
				for (const row of batch) secondRun.add(row.id);
			},
		});
		expect(pageSpy.mock.calls[0]![1]).toBe(String(2 * PAGE_SIZE));
		expect([...firstRun].filter((id) => secondRun.has(id))).toEqual([]);
		expect(sortedIds(new Set([...firstRun, ...secondRun]))).toEqual(sortedIds(rows.map((row) => row.id)));
		expect(await kv.get('scan:resume:0')).toBeNull();
	});

	it('does nothing while another scan of the same job holds the lock', async () => {
		const kv = new MockKVProvider();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const firstPage = vi.fn(async () => {
			await gate;
			return {rows: [], pageState: null};
		});
		const first = scanByTokenRanges({job: 'locked', ranges: 1, concurrency: 1, kv, page: firstPage, onRows: vi.fn()});
		await vi.waitFor(() => expect(firstPage).toHaveBeenCalled());

		const secondPage = vi.fn(async () => ({rows: [], pageState: null}));
		await scanByTokenRanges({job: 'locked', ranges: 4, concurrency: 2, kv, page: secondPage, onRows: vi.fn()});
		expect(secondPage).not.toHaveBeenCalled();

		release();
		await first;
		expect(await kv.get('job:locked')).toBeNull();
	});

	it('stops without touching checkpoints once the job lock is lost', async () => {
		const kv = new MockKVProvider();
		const page = vi.fn(async () => {
			await kv.set('job:lost', 'another-worker');
			return {rows: [{id: 1, token: 0n}], pageState: 'next'};
		});
		await scanByTokenRanges<FakeRow>({job: 'lost', ranges: 1, concurrency: 1, kv, page, onRows: vi.fn()});
		expect(page).toHaveBeenCalledTimes(1);
		expect(await kv.get('scan:lost:0')).toBeNull();
		expect(await kv.get('job:lost')).toBe('another-worker');
	});
});

// The Cassandra driver's own Murmur3Partitioner hash, an independent check on the in-memory executor's token maths.
const {Murmur3Tokenizer} = createRequire(import.meta.url)('cassandra-driver/lib/tokenizer.js');
const driverTokenizer = new Murmur3Tokenizer();

function driverToken(id: bigint): bigint {
	const key = Buffer.alloc(8);
	key.writeBigInt64BE(id);
	return BigInt(driverTokenizer.hash(key).getValue().toString());
}

describe('users token range pages on the in-memory executor', () => {
	const repository = new UserDataRepository();

	async function seedUsers(ids: ReadonlyArray<bigint>): Promise<void> {
		for (const id of ids) {
			await upsertOne(Users.upsertAll({...EMPTY_USER_ROW, user_id: createUserID(id), username: `user${id}`}));
		}
	}

	it('filters on the Cassandra Murmur3Partitioner token of a bigint partition key', async () => {
		const tokens = new Map<bigint, bigint>([
			// MurmurHash3 vectors from the Python driver's tests: 8 bytes of 0xfe (sign-extended tail) and of 0x10.
			[-72340172838076674n, -8927430733708461935n],
			[1157442765409226768n, 1446172840243228796n],
			...[0n, 1n, -1n, MIN_TOKEN, MAX_TOKEN, 1_300_000_000_000_000_000n].map((id) => [id, driverToken(id)] as const),
		]);
		await seedUsers([...tokens.keys()]);
		for (const [id, token] of tokens) {
			const page = await repository.scanUsersTokenRangePage({start: token, end: token}, 10);
			expect(page.users.map((user) => user.id)).toEqual([id]);
		}
	});

	it.each([1, 7, 64])(
		'serves every user exactly once, from the range holding its token, across %i ranges',
		async (ranges) => {
			const ids = Array.from({length: 200}, (_, i) => 1_300_000_000_000_000_000n + BigInt(i) * 4_194_304n);
			await seedUsers(ids);
			const servedBy = new Map<string, Array<bigint>>();
			await scanByTokenRanges({
				job: `in-memory-${ranges}`,
				ranges,
				concurrency: 4,
				kv: new MockKVProvider(),
				page: async (range, pageState) => {
					// The in-memory executor does not page, so one page holds every user of the range.
					const page = await repository.scanUsersTokenRangePage(range, ids.length, pageState);
					for (const user of page.users) {
						servedBy.set(String(user.id), [...(servedBy.get(String(user.id)) ?? []), range.start]);
					}
					return {rows: page.users, pageState: page.pageState};
				},
				onRows: async () => {},
			});
			const ring = splitTokenRing(ranges);
			const expected = new Map(
				ids.map((id) => {
					const token = driverToken(id);
					return [String(id), [ring.find((range) => token >= range.start && token <= range.end)!.start]];
				}),
			);
			expect(servedBy).toEqual(expected);
		},
	);
});
