// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';
import {setInjectedSearchProvider} from '@app/api/SearchFactory';
import type {ISearchProvider} from '@app/api/search/ISearchProvider';
import reindexUserGuildMembers, {enqueueUsernameReindex} from '@app/api/worker/tasks/ReindexUserGuildMembers';
import {clearWorkerDependencies, setWorkerDependenciesForTest} from '@app/api/worker/WorkerContext';
import {Histogram} from '@fluxer/hono/src/middleware/Metrics';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import type {WorkerTaskHelpers} from '@pkgs/worker/src/contracts/WorkerTask';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {ZodError} from 'zod';

const userId = createUserID(700n);
const guildA = createGuildID(8n);
const guildB = createGuildID(9n);
const helpers = {jobId: 1n} as WorkerTaskHelpers;
const payload = {user_id: '700', enqueued_at_ms: 1000};
const user = (username: string) =>
	new User({user_id: userId, username, discriminator: 0, username_state: 'selected', flags: 0n} as UserRow);

const findUnique = vi.fn();
const getUserGuildIds = vi.fn();
const listGuilds = vi.fn();
const getMember = vi.fn();
const updateMember = vi.fn();

beforeEach(() => {
	vi.resetAllMocks();
	findUnique.mockResolvedValue(user('current'));
	getUserGuildIds.mockResolvedValue([guildA]);
	listGuilds.mockResolvedValue([{id: guildA, membersIndexedAt: new Date(0)}]);
	getMember.mockImplementation(async (guildId) => ({guildId, userId}));
	updateMember.mockResolvedValue(undefined);
	setWorkerDependenciesForTest({
		userRepository: {findUnique, getUserGuildIds} as never,
		guildRepository: {listGuilds, getMember} as never,
	});
	setInjectedSearchProvider({getGuildMemberSearchService: () => ({updateMember})} as unknown as ISearchProvider);
});

afterEach(() => {
	clearWorkerDependencies();
	setInjectedSearchProvider(undefined);
	vi.restoreAllMocks();
});

describe('username reindex edge cases', () => {
	test('uses the same key for one generation and a different key for a later rename', async () => {
		const addJob = vi.fn().mockResolvedValue(1n);
		const worker = {addJob} as unknown as IWorkerService;
		await enqueueUsernameReindex(worker, userId, 9007199254740993n, () => 1000);
		await enqueueUsernameReindex(worker, userId, 9007199254740993n, () => 2000);
		await enqueueUsernameReindex(worker, userId, 9007199254740994n, () => 3000);
		const options = addJob.mock.calls.map((call) => call[2]);
		expect(options[0].jobKey).toBe(options[1].jobKey);
		expect(options[2].jobKey).not.toBe(options[0].jobKey);
		for (const option of options) expect(option).toMatchObject({requireLedger: true, maxAttempts: 25});
	});

	test('a retry after partial search progress rereads the latest user for every guild', async () => {
		const first = user('first-current');
		const latest = user('latest-current');
		findUnique.mockResolvedValueOnce(first).mockResolvedValueOnce(latest);
		getUserGuildIds.mockResolvedValue([guildA, guildB]);
		listGuilds.mockResolvedValue([
			{id: guildA, membersIndexedAt: new Date(0)},
			{id: guildB, membersIndexedAt: new Date(0)},
		]);
		updateMember.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('second guild search failed'));
		const queued = {...payload, username: 'stale-queued-name', __jobId: '1'};
		await expect(reindexUserGuildMembers(queued, helpers)).rejects.toThrow('second guild search failed');
		await reindexUserGuildMembers(queued, helpers);
		expect(findUnique).toHaveBeenCalledTimes(2);
		expect(findUnique).toHaveBeenNthCalledWith(2, userId);
		expect(updateMember.mock.calls.map((call) => call[1])).toEqual([first, first, latest, latest]);
	});

	test('an unavailable search provider rejects instead of completing the job', async () => {
		setInjectedSearchProvider(undefined);
		await expect(reindexUserGuildMembers(payload, helpers)).rejects.toThrow('Username member search is unavailable');
		expect(updateMember).not.toHaveBeenCalled();
	});

	test('queue age uses seconds and clamps future timestamps to zero', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(10000);
		const observe = vi.spyOn(Histogram.prototype, 'observe');
		findUnique.mockResolvedValue(null);
		await reindexUserGuildMembers(payload, helpers);
		await reindexUserGuildMembers({...payload, enqueued_at_ms: 20000}, helpers);
		expect(observe.mock.calls.map((call) => call[0])).toEqual([9, 0]);
		expect(getUserGuildIds).not.toHaveBeenCalled();
	});

	test.each([
		{},
		{user_id: 'not-a-user', enqueued_at_ms: 1000},
		{user_id: '-1', enqueued_at_ms: 1000},
		{user_id: '700', enqueued_at_ms: -1},
		{user_id: '700', enqueued_at_ms: 1.5},
		{user_id: '700', enqueued_at_ms: Number.POSITIVE_INFINITY},
	])('rejects malformed payload %j before repository or metric work', async (invalid) => {
		const observe = vi.spyOn(Histogram.prototype, 'observe');
		await expect(reindexUserGuildMembers(invalid, helpers)).rejects.toBeInstanceOf(ZodError);
		expect(findUnique).not.toHaveBeenCalled();
		expect(observe).not.toHaveBeenCalled();
	});

	test('skips unindexed guilds and membership removed after enqueue', async () => {
		getUserGuildIds.mockResolvedValue([guildA, guildB]);
		listGuilds.mockResolvedValue([
			{id: guildA, membersIndexedAt: null},
			{id: guildB, membersIndexedAt: new Date(0)},
		]);
		getMember.mockResolvedValue(null);
		await reindexUserGuildMembers(payload, helpers);
		expect(getMember).toHaveBeenCalledExactlyOnceWith(guildB, userId);
		expect(updateMember).not.toHaveBeenCalled();
	});
});
