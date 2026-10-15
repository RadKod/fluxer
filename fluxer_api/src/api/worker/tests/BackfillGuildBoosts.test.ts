// SPDX-License-Identifier: AGPL-3.0-or-later

import backfillGuildBoosts from '@app/api/worker/tasks/admin_bulk/BackfillGuildBoosts';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
	fetchPage: vi.fn(),
	recompute: vi.fn(),
	audit: vi.fn(),
	kv: {
		get: vi.fn(),
		set: vi.fn(),
		del: vi.fn(),
		acquireLock: vi.fn(),
		extendLock: vi.fn(),
		releaseLock: vi.fn(),
	},
}));

vi.mock('@app/api/database/CassandraQueryExecution', () => ({fetchPage: mocks.fetchPage}));
vi.mock('@app/api/middleware/ServiceSingletons', () => ({
	getGuildBoostService: () => ({recompute: mocks.recompute}),
}));
vi.mock('@app/api/admin/services/AdminAuditService', () => ({
	AdminAuditService: class {
		createAuditLog = mocks.audit;
	},
}));
vi.mock('@app/api/worker/WorkerContext', () => ({
	getWorkerDependencies: () => ({kvClient: mocks.kv}),
}));

const CHECKPOINT_KEY = 'guild_boost:backfill:checkpoint';
const payload = {admin_user_id: '42', audit_log_reason: 'Repair entitlement projection'};
let stored: Map<string, string>;

function helpers(): WorkerTaskHelpers {
	return {
		jobId: 99n,
		logger: {info: vi.fn(), warn: vi.fn(), error: vi.fn()} as unknown as WorkerTaskHelpers['logger'],
		addJob: vi.fn(),
		reportProgress: vi.fn(),
		shouldCancel: vi.fn().mockResolvedValue(false),
		setContextLink: vi.fn(),
	};
}

function pages(counts = [100, 100, 7]) {
	mocks.fetchPage.mockImplementation(async (_query, _params, options) => {
		expect(options.pageSize).toBe(100);
		const index = options.pageState === null || options.pageState === undefined ? 0 : Number(options.pageState);
		const first = counts.slice(0, index).reduce((sum, count) => sum + count, 0);
		return {
			rows: Array.from({length: counts[index]!}, (_, i) => ({guild_id: BigInt(first + i + 1)})),
			pageState: index + 1 < counts.length ? String(index + 1) : null,
		};
	});
}

describe('guild boost maintenance backfill', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		stored = new Map();
		mocks.kv.get.mockImplementation(async (key) => stored.get(key) ?? null);
		mocks.kv.set.mockImplementation(async (key, value) => {
			stored.set(key, value);
			return 'OK';
		});
		mocks.kv.del.mockImplementation(async (key) => Number(stored.delete(key)));
		mocks.kv.acquireLock.mockResolvedValue(true);
		mocks.kv.extendLock.mockResolvedValue(true);
		mocks.kv.releaseLock.mockResolvedValue(true);
		mocks.recompute.mockResolvedValue(undefined);
		mocks.audit.mockResolvedValue(undefined);
		pages();
	});
	afterEach(() => vi.useRealTimers());

	it('reads three bounded pages and uses at most four public recomputes at once', async () => {
		let active = 0;
		let maximum = 0;
		mocks.recompute.mockImplementation(async () => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active--;
		});
		const taskHelpers = helpers();
		const result = await backfillGuildBoosts(payload, taskHelpers);
		expect(result).toMatchObject({successful_count: 207, failed_count: 0, processed_count: 207});
		expect(maximum).toBe(4);
		expect(mocks.recompute).toHaveBeenCalledTimes(207);
		expect(mocks.recompute).toHaveBeenCalledWith(207n);
		expect(mocks.fetchPage).toHaveBeenCalledTimes(3);
		expect(mocks.fetchPage.mock.calls[0]?.[0]).toMatch(/^SELECT guild_id FROM guild_boost_state/i);
		expect(stored.has(CHECKPOINT_KEY)).toBe(false);
		expect(taskHelpers.reportProgress).toHaveBeenLastCalledWith(207, 207, expect.any(String));
		expect(mocks.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				adminUserId: 42n,
				action: 'backfill_guild_boosts',
				auditLogReason: payload.audit_log_reason,
			}),
		);
	});

	it('resumes a new job from the last successful page after a page fetch fails', async () => {
		const readPage = mocks.fetchPage.getMockImplementation()!;
		mocks.fetchPage.mockImplementation(async (...args) => {
			if (args[2].pageState === '1') throw new Error('Cassandra unavailable');
			return readPage(...args);
		});
		await expect(backfillGuildBoosts(payload, helpers())).rejects.toThrow('Cassandra unavailable');
		expect(stored.get(CHECKPOINT_KEY)).toBe('1');
		mocks.fetchPage.mockImplementation(readPage);
		mocks.recompute.mockClear();
		const result = await backfillGuildBoosts(payload, {...helpers(), jobId: 100n});
		expect(result).toMatchObject({successful_count: 107, failed_count: 0});
		expect(mocks.recompute).toHaveBeenNthCalledWith(1, 101n);
		expect(stored.has(CHECKPOINT_KEY)).toBe(false);
	});

	it('continues after a guild fails and pins the cursor before the first failing page', async () => {
		mocks.recompute.mockImplementation(async (guildId) => {
			if (guildId === 105n) throw new Error('Guild update failed');
		});
		const result = await backfillGuildBoosts(payload, helpers());
		expect(result).toMatchObject({
			processed_count: 207,
			successful_count: 206,
			failed_count: 1,
			failed: [{id: '105', error: 'Guild update failed'}],
			checkpoint: '1',
			incomplete: true,
		});
		expect(mocks.recompute).toHaveBeenCalledWith(207n);
		expect(stored.get(CHECKPOINT_KEY)).toBe('1');
		mocks.recompute.mockResolvedValue(undefined);
		mocks.recompute.mockClear();
		await backfillGuildBoosts(payload, helpers());
		expect(mocks.recompute).toHaveBeenCalledTimes(107);
		expect(stored.has(CHECKPOINT_KEY)).toBe(false);
	});

	it('keeps only one hundred failure samples while counting every failure', async () => {
		mocks.recompute.mockRejectedValue(new Error('Unavailable'));
		const result = await backfillGuildBoosts(payload, helpers());
		expect(result).toMatchObject({processed_count: 207, failed_count: 207, successful_count: 0, incomplete: true});
		expect(result?.failed).toHaveLength(100);
		expect(stored.has(CHECKPOINT_KEY)).toBe(false);
	});

	it('starts a fresh scan after a completed run', async () => {
		pages([2]);
		await backfillGuildBoosts(payload, helpers());
		await backfillGuildBoosts(payload, {...helpers(), jobId: 100n});
		expect(mocks.recompute.mock.calls).toEqual([[1n], [2n], [1n], [2n]]);
		expect(stored.has(CHECKPOINT_KEY)).toBe(false);
	});

	it('refuses a second scan without touching its checkpoint or releasing its lock', async () => {
		mocks.kv.acquireLock.mockResolvedValue(false);
		await expect(backfillGuildBoosts(payload, helpers())).rejects.toThrow(/already running/i);
		expect(mocks.fetchPage).not.toHaveBeenCalled();
		expect(mocks.kv.get).not.toHaveBeenCalled();
		expect(mocks.kv.releaseLock).not.toHaveBeenCalled();
	});

	it('renews a slow scan and refuses work after lease loss', async () => {
		vi.useFakeTimers();
		let finishRead!: (value: {rows: Array<{guild_id: bigint}>; pageState: string | null}) => void;
		mocks.fetchPage.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRead = resolve;
				}),
		);
		mocks.kv.extendLock.mockResolvedValue(false);
		const run = backfillGuildBoosts(payload, helpers());
		await vi.advanceTimersByTimeAsync(10_001);
		finishRead({rows: [{guild_id: 1n}], pageState: '1'});
		await expect(run).rejects.toThrow(/lease/i);
		expect(mocks.recompute).not.toHaveBeenCalled();
		expect(mocks.kv.set).not.toHaveBeenCalled();
		expect(mocks.kv.releaseLock).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('cancels before the next chunk without advancing a partial page', async () => {
		const taskHelpers = helpers();
		vi.mocked(taskHelpers.shouldCancel)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		await expect(backfillGuildBoosts(payload, taskHelpers)).rejects.toMatchObject({name: 'JobCancelledError'});
		expect(mocks.recompute).toHaveBeenCalledTimes(4);
		expect(mocks.kv.set).not.toHaveBeenCalled();
		expect(mocks.kv.releaseLock).toHaveBeenCalledTimes(1);
	});
});
