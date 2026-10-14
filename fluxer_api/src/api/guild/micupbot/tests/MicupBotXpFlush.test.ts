// SPDX-License-Identifier: AGPL-3.0-or-later

import {MICUPBOT_XP_COUNTER, MICUPBOT_XP_DIRTY_SET, micupBotXpCounterId} from '@app/api/database/types/MicupBotTypes';
import {GUILD, levelsFixture, taskHelpers, USER} from '@app/api/guild/micupbot/tests/MicupBotLevelsTestUtils';
import {counterDirtyKey, counterPartition} from '@app/api/infrastructure/KVCounterService';
import {Logger} from '@app/api/Logger';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import flushMicupBotXp from '@app/api/worker/tasks/FlushMicupBotXp';
import flushMicupBotXpSlice from '@app/api/worker/tasks/FlushMicupBotXpSlice';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';

let harness: ApiTestHarness;
beforeAll(async () => {
	harness = await createApiTestHarness();
});
beforeEach(async () => {
	await harness.reset();
});
afterEach(() => {
	clearWorkerDependencies();
	vi.restoreAllMocks();
});
afterAll(async () => {
	await harness?.shutdown();
});

it('the flush writes absolute xp to Cassandra from its own dirty set', async () => {
	const {levels, counterService, repository, kvClient} = levelsFixture();
	const id = micupBotXpCounterId(GUILD, USER);
	const partition = counterPartition(MICUPBOT_XP_COUNTER, id);
	await repository.setMemberXp(GUILD, USER, 100n);
	await counterService.add(MICUPBOT_XP_COUNTER, id, 20);
	expect(await kvClient.sismember(counterDirtyKey(partition), `${MICUPBOT_XP_COUNTER}:${id}`)).toBe(0);
	const flush = vi.spyOn(counterService, 'flushPartition');
	await levels.flushSlice({slice: Math.floor(partition / 64), minute: 7});
	expect(await repository.getMemberXp(GUILD, USER)).toBe(120n);
	expect(flush).toHaveBeenCalledTimes(64);
	expect(flush.mock.calls.every(([, max, dirty]) => max === 1000 && dirty === MICUPBOT_XP_DIRTY_SET)).toBe(true);
	setWorkerDependenciesForTest({kvClient});
	await flushMicupBotXpSlice({slice: Math.floor(partition / 64), minute: 8}, taskHelpers());
	expect(await repository.getMemberXp(GUILD, USER)).toBe(120n);
});

it('the xp cron queues sixteen slices keyed by minute', async () => {
	const helpers = taskHelpers();
	const jobs = vi.spyOn(helpers, 'addJob');
	vi.spyOn(Date, 'now').mockReturnValue(600_001);
	await flushMicupBotXp({}, helpers);
	expect(jobs.mock.calls).toEqual(
		Array.from({length: 16}, (_, slice) => [
			'flushMicupBotXpSlice',
			{slice, minute: 10},
			{jobKey: `mbxp:10:${slice}`, skipLedger: true},
		]),
	);
});

it('a failed first-XP index write is repaired by the flush', async () => {
	const {levels, counterService, repository} = levelsFixture();
	vi.spyOn(repository, 'addUserGuild').mockRejectedValueOnce(new Error('index unavailable'));
	await levels.award({guildId: GUILD, userId: USER, channelId: null, xp: 20, source: 'voice'});
	expect(await repository.listUserGuilds(USER)).toEqual([]);
	const batch = vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeBatch');
	const id = micupBotXpCounterId(GUILD, USER);
	const partition = counterPartition(MICUPBOT_XP_COUNTER, id);
	await counterService.flushPartition(partition, 1000, MICUPBOT_XP_DIRTY_SET);
	expect(await repository.getMemberXp(GUILD, USER)).toBe(20n);
	expect(await repository.listUserGuilds(USER)).toEqual([GUILD]);
	expect(batch).toHaveBeenCalledTimes(1);
	expect(batch.mock.calls[0]![0]).toHaveLength(2);
	expect(batch.mock.calls[0]![1]).toBe(true);
	await counterService.add(MICUPBOT_XP_COUNTER, id, 0);
	await counterService.flushPartition(partition, 1000, MICUPBOT_XP_DIRTY_SET);
	expect(await repository.getMemberXp(GUILD, USER)).toBe(20n);
	expect(await repository.listUserGuilds(USER)).toEqual([GUILD]);
});

it('the xp slice visits every partition and warns when its full batches exhaust the budget', async () => {
	const {levels, counterService} = levelsFixture();
	let now = 100_000;
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	const flush = vi.spyOn(counterService, 'flushPartition').mockImplementation(async () => {
		now += 1000;
		return 1000;
	});
	const warn = vi.spyOn(Logger.child({}), 'warn');
	await levels.flushSlice({slice: 2, minute: 63});
	expect(flush.mock.calls.map(([p]) => p)).toEqual([191, ...Array.from({length: 63}, (_, i) => 128 + i)]);
	expect(warn).toHaveBeenCalledWith(
		{slice: 2, flushed: 64_000, ms: 64_000},
		expect.stringContaining('whole 45 s budget'),
	);
});

it('a failed XP batch stays dirty until xp and its user guild index are both written', async () => {
	const {counterService, repository, kvClient} = levelsFixture();
	const id = micupBotXpCounterId(GUILD, USER);
	const partition = counterPartition(MICUPBOT_XP_COUNTER, id);
	await counterService.add(MICUPBOT_XP_COUNTER, id, 20);
	vi.spyOn(InMemoryCassandraQueryExecutor.prototype, 'executeBatch').mockRejectedValueOnce(
		new Error('batch unavailable'),
	);
	expect(await counterService.flushPartition(partition, 1000, MICUPBOT_XP_DIRTY_SET)).toBe(0);
	expect(await repository.getMemberXp(GUILD, USER)).toBeNull();
	expect(await repository.listUserGuilds(USER)).toEqual([]);
	expect(
		await kvClient.sismember(counterDirtyKey(partition, MICUPBOT_XP_DIRTY_SET), `${MICUPBOT_XP_COUNTER}:${id}`),
	).toBe(1);
	expect(await counterService.flushPartition(partition, 1000, MICUPBOT_XP_DIRTY_SET)).toBe(1);
	expect(await repository.getMemberXp(GUILD, USER)).toBe(20n);
	expect(await repository.listUserGuilds(USER)).toEqual([GUILD]);
});
