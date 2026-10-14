// SPDX-License-Identifier: AGPL-3.0-or-later

import {setImmediate} from 'node:timers/promises';
import {type ChannelID, createChannelID, createGuildID} from '@app/api/BrandedTypes';
import {ThreadListService} from '@app/api/channel/services/thread/ThreadListService';
import type {ThreadServiceContext} from '@app/api/channel/services/thread/ThreadServiceContext';
import type {Channel} from '@app/api/models/Channel';
import {ThreadState} from '@app/api/models/ThreadState';
import {ChannelTypes} from '@fluxer/constants/src/ChannelConstants';
import {describe, expect, it} from 'vitest';

describe('simultaneous admin thread pages', () => {
	it('preserves thread ID order when the state query returns shuffled rows', async () => {
		const guildId = createGuildID(5000n);
		const parentId = createChannelID(100n);
		const ids = [10n, 20n, 30n].map(createChannelID);
		const states = [ids[2]!, ids[0]!, ids[1]!].map(
			(threadId) =>
				new ThreadState({
					thread_id: threadId,
					guild_id: guildId,
					parent_id: parentId,
					type: ChannelTypes.PUBLIC_THREAD,
					archived: false,
					locked: false,
					invitable: null,
					auto_archive_duration: 60,
					archive_timestamp: null,
					created_at: new Date('2026-01-01T00:00:00Z'),
					flags: 0,
					applied_tags: null,
					member_count: 0,
					member_ids_preview: null,
					has_starter: false,
					state_version: 1,
				}),
		);
		const channels = states.map((state) => ({
			id: state.threadId,
			guildId,
			parentId,
			type: ChannelTypes.PUBLIC_THREAD,
		})) as Array<Channel>;
		const service = new ThreadListService({
			channelRepository: {
				channelData: {
					listChannels: async (requested: Array<ChannelID>) =>
						channels.filter((channel) => requested.includes(channel.id)),
				},
				threads: {
					listGuildThreadIdsPage: async () => ({threadIds: ids, cursor: null}),
					getStates: async () => states,
					getStatsMany: async () => new Map(),
				},
			},
		} as unknown as ThreadServiceContext);
		const page = await service.listGuildThreadsForAdmin(guildId, {limit: 100});
		expect(page.threads.map((thread) => thread.id)).toEqual(['10', '20', '30']);
	});

	it('rejects page requests beyond ten active and one hundred pending without retaining them', async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		const failures: Array<{status: number}> = [];
		const service = new ThreadListService({
			channelRepository: {
				threads: {
					listGuildThreadIdsPage: async () => {
						reads += 1;
						await blocked;
						return {threadIds: [], cursor: null};
					},
					getStates: async () => [],
				},
			},
		} as unknown as ThreadServiceContext);
		const requests = Array.from({length: 121}, () =>
			service.listGuildThreadsForAdmin(createGuildID(5000n), {limit: 100}).catch((error) => {
				failures.push(error);
			}),
		);
		try {
			await setImmediate();
			expect(reads).toBe(10);
			expect(failures).toHaveLength(11);
			expect(failures.every((error) => error.status === 503)).toBe(true);
		} finally {
			release();
			await Promise.all(requests);
		}
		expect(reads).toBe(110);
		await expect(service.listGuildThreadsForAdmin(createGuildID(5000n), {limit: 100})).resolves.toEqual({
			threads: [],
			next_cursor: null,
		});
	});

	it('shares a ten page read budget across service instances and releases it after failures', async () => {
		let active = 0;
		let peak = 0;
		let calls = 0;
		async function readPage() {
			active += 1;
			peak = Math.max(peak, active);
			const number = ++calls;
			try {
				await setImmediate();
				if (number === 1) throw new Error('page read failed');
				return {threadIds: [], cursor: null};
			} finally {
				active -= 1;
			}
		}
		function createService() {
			return new ThreadListService({
				channelRepository: {
					threads: {
						listGuildThreadIds: async () => (await readPage()).threadIds,
						listGuildThreadIdsPage: readPage,
						getStates: async () => [],
					},
				},
			} as unknown as ThreadServiceContext);
		}
		const results = await Promise.allSettled(
			Array.from({length: 31}, () => createService().listGuildThreadsForAdmin(createGuildID(5000n), {limit: 100})),
		);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		expect(peak).toBeLessThanOrEqual(10);
		expect(calls).toBe(31);
		expect(active).toBe(0);
		await expect(createService().listGuildThreadsForAdmin(createGuildID(5000n), {limit: 100})).resolves.toEqual({
			threads: [],
			next_cursor: null,
		});
	});
});
