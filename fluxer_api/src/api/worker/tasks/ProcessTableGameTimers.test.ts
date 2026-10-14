// SPDX-License-Identifier: AGPL-3.0-or-later

import {TABLE_GAME_LOBBY_TIMEOUT_MS} from '@app/api/table_game/TableGameLimits';
import {tableGameTimerShard} from '@app/api/table_game/TableGameRepository';
import {
	CHANNEL,
	cid,
	conn,
	createFixture,
	type Fixture,
	SLOT,
	THEME,
	uid,
} from '@app/api/table_game/tests/TableGameTestFixture';
import {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {CronScheduler} from '@app/api/worker/CronScheduler';
import {JOBS_STREAM_MAX_AGE_MS} from '@app/api/worker/JetStreamWorkerQueue';
import processTableGameTimers from '@app/api/worker/tasks/ProcessTableGameTimers';
import {registerCronJobs} from '@app/api/worker/WorkerMain';
import type {WorkerService} from '@app/api/worker/WorkerService';
import {TABLE_GAME_TIMER_SHARDS, TABLE_GAME_TURN_MS} from '@fluxer/constants/src/TableGameConstants';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const START = new Date('2026-10-03T10:00:00.000Z').getTime();

describe('table game timers', () => {
	let f: Fixture;

	beforeEach(() => {
		vi.useFakeTimers({toFake: ['Date']});
		vi.setSystemTime(START);
		f = createFixture();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('due member resolves once even with two workers (lease + CAS)', async () => {
		const env = await f.fill();
		vi.setSystemTime(START + TABLE_GAME_TURN_MS.okey.normal);
		const before = f.dispatches.length;
		const [first, second] = await Promise.all([
			f.service.processDueTimers(Date.now()),
			f.service.processDueTimers(Date.now()),
		]);
		expect(first.processed + second.processed).toBe(1);
		expect((await f.load())!.version).toBe(env.version + 1);
		expect(f.dispatches.length - before).toBe(4);
	});

	it('stale member score is corrected without a state change', async () => {
		const env = await f.fill();
		await f.repository.scheduleTimer(CHANNEL, SLOT, START - 1_000);
		await f.service.processDueTimers(Date.now());
		expect((await f.load())!.version).toBe(env.version);
		const shard = tableGameTimerShard(`${CHANNEL}:${SLOT}`);
		expect(await f.repository.dueTimers(shard, Date.now(), 200)).toEqual([]);
		expect(await f.repository.dueTimers(shard, START + TABLE_GAME_TURN_MS.okey.normal, 200)).toEqual([
			`${CHANNEL}:${SLOT}`,
		]);
	});

	it('lease is released after the shard is processed', async () => {
		await f.fill();
		vi.setSystemTime(START + TABLE_GAME_TURN_MS.okey.normal);
		await f.service.processDueTimers(Date.now());
		for (let shard = 0; shard < TABLE_GAME_TIMER_SHARDS; shard++) {
			expect(await f.repository.acquireTimerLease(shard, 'next-tick')).toBe(true);
		}
	});

	it('a tick stops at its budget and leaves the rest due', async () => {
		const channels = Array.from({length: 12}, (_, index) => String(70_000 + index));
		for (const [index, channelId] of channels.entries()) {
			const userId = String(300 + index);
			f.themes.set(channelId, THEME);
			f.joinVoice(userId, channelId);
			await f.service.create({
				userId: uid(userId),
				channelId: cid(channelId),
				slot: SLOT,
				game: 'okey',
				speed: 'normal',
				connectionId: conn(userId),
			});
		}
		vi.setSystemTime(START + TABLE_GAME_LOBBY_TIMEOUT_MS);
		f.gateway.dispatchPresence.mockImplementation(async () => {
			vi.setSystemTime(Date.now() + 300); // a slow gateway: each settled table costs 300 ms
		});
		const now = Date.now();
		const tick = await f.service.processDueTimers(now);
		expect(tick.processed).toBeGreaterThan(0);
		expect(tick.processed).toBeLessThan(channels.length);
		const ended = await Promise.all(channels.map((channelId) => f.load(channelId)));
		expect(ended.filter((env) => env!.status === 'ended')).toHaveLength(tick.processed);
		const next = await f.service.processDueTimers(now);
		expect(next.processed).toBeGreaterThan(0);
	});

	it('the task warns when a tick takes over 500 ms', async () => {
		const warn = vi.fn();
		const service = {processDueTimers: vi.fn().mockResolvedValue({processed: 3, durationMs: 650})};
		const helpers = {logger: {...new NoopLogger(), warn}} as unknown as WorkerTaskHelpers;
		await processTableGameTimers({}, helpers, service);
		expect(service.processDueTimers).toHaveBeenCalledWith(Date.now());
		expect(warn).toHaveBeenCalledWith({processed: 3, durationMs: 650}, expect.stringContaining('500 ms'));
		service.processDueTimers.mockResolvedValue({processed: 3, durationMs: 120});
		await processTableGameTimers({}, helpers, service);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('the cron queues the timer every second', async () => {
		vi.useRealTimers();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-15T12:00:00.500Z'));
		const addJob = vi.fn().mockResolvedValue(1n);
		const scheduler = new CronScheduler({addJob} as unknown as WorkerService, new NoopLogger());
		registerCronJobs(scheduler, JOBS_STREAM_MAX_AGE_MS);
		scheduler.start();
		await vi.advanceTimersByTimeAsync(10_000);
		await scheduler.stop();
		expect(addJob.mock.calls.filter(([task]) => task === 'processTableGameTimers')).toHaveLength(10);
	});
});
