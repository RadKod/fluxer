// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID, createRoleID, createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {type GuildRosterEventRow, rosterSlotOf} from '@app/api/database/types/GuildRosterTypes';
import {GuildRosterRepository} from '@app/api/guild/roster/GuildRosterRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const guildId = createGuildID(12345n << 22n);
const otherGuild = createGuildID((12345n + 4096n) << 22n);
function row(overrides: Partial<GuildRosterEventRow> = {}): GuildRosterEventRow {
	return {
		guild_id: guildId,
		event_id: 101n,
		name: 'Raid',
		voice_channel_id: createChannelID(102n),
		announce_channel_id: createChannelID(103n),
		mention_role_id: createRoleID(104n),
		main_size: 10,
		sub_size: 5,
		enabled: true,
		created_by: createUserID(105n),
		created_at: new Date('2026-10-02T10:00:00Z'),
		updated_at: new Date('2026-10-02T10:00:00Z'),
		version: 0,
		...overrides,
	};
}

describe('GuildRosterRepository', () => {
	let executor: InMemoryCassandraQueryExecutor;
	const repository = new GuildRosterRepository();
	beforeEach(() => {
		executor = new InMemoryCassandraQueryExecutor();
		setCassandraQueryExecutorForTesting(executor);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});
	it('create writes the event and its slot row', async () => {
		const batch = vi.spyOn(executor, 'executeBatch');
		await repository.create(row());
		expect(batch).toHaveBeenCalledTimes(1);
		expect(batch.mock.calls[0]![0]).toHaveLength(2);
		expect(batch.mock.calls[0]![1]).not.toBe(false);
		expect(await repository.get(guildId, 101n)).toEqual(row());
		expect(await repository.listSlot(rosterSlotOf(guildId), null, 10)).toEqual([
			{slot: rosterSlotOf(guildId), guild_id: guildId, event_id: 101n},
		]);
	});
	it('listByGuild returns only that guild', async () => {
		await repository.create(row());
		await repository.create(row({guild_id: otherGuild}));
		expect(await repository.listByGuild(guildId)).toEqual([row()]);
		expect(await repository.get(guildId, 999n)).toBeNull();
	});
	it('update applies at the expected version only', async () => {
		await repository.create(row());
		const changed = row({name: 'New', mention_role_id: null, enabled: false});
		expect(await repository.update(changed, 0)).toBe(true);
		expect(await repository.update(row({name: 'Stale'}), 0)).toBe(false);
		expect(await repository.get(guildId, 101n)).toEqual({...changed, version: 1});
		expect(await repository.update(row({event_id: 999n}), 0)).toBe(false);
	});
	it('delete removes both rows', async () => {
		await repository.create(row());
		await repository.delete(guildId, 101n);
		expect(await repository.get(guildId, 101n)).toBeNull();
		expect(await repository.listSlot(rosterSlotOf(guildId), null, 10)).toEqual([]);
		await repository.delete(guildId, 101n);
	});
	it('concurrent update and delete do not resurrect the event', async () => {
		await repository.create(row());
		const updateStarted = Promise.withResolvers<void>();
		const releaseUpdate = Promise.withResolvers<void>();
		const execute = executor.executeQuery.bind(executor);
		const queries = vi.spyOn(executor, 'executeQuery').mockImplementation(async (query) => {
			if (query.kvMeta?.action === 'patch') {
				updateStarted.resolve();
				await releaseUpdate.promise;
			}
			return execute(query);
		});
		const updating = repository.update(row({name: 'Concurrent'}), 0);
		await updateStarted.promise;
		try {
			await repository.delete(guildId, 101n);
		} finally {
			releaseUpdate.resolve();
		}
		expect(await updating).toBe(false);
		expect(await repository.get(guildId, 101n)).toBeNull();
		expect(await repository.listSlot(rosterSlotOf(guildId), null, 10)).toEqual([]);
		// The in-memory executor cannot model Paxos racing an unconditional write; require both writes to use LWT.
		const deletion = queries.mock.calls.find(
			([query]) => query.kvMeta?.action === 'delete' && query.kvMeta.table.name === 'guild_roster_events',
		)?.[0];
		expect(deletion?.cql).toContain('IF created_at = :expected_created_at');
	});
	it('delete still applies when an update wins after the row was read', async () => {
		await repository.create(row());
		const execute = executor.executeQuery.bind(executor);
		vi.spyOn(executor, 'executeQuery').mockImplementation(async (query) => {
			if (query.kvMeta?.action === 'delete' && query.kvMeta.table.name === 'guild_roster_events') {
				expect(await repository.update(row({name: 'Concurrent'}), 0)).toBe(true);
			}
			return execute(query);
		});
		await repository.delete(guildId, 101n);
		expect(await repository.get(guildId, 101n)).toBeNull();
		expect(await repository.listSlot(rosterSlotOf(guildId), null, 10)).toEqual([]);
	});
	it('delete retries slot cleanup after the event was already removed', async () => {
		await repository.create(row());
		const execute = executor.executeQuery.bind(executor);
		vi.spyOn(executor, 'executeQuery').mockImplementation(async (query) => {
			if (query.kvMeta?.action === 'delete' && query.kvMeta.table.name === 'guild_roster_events_by_slot') {
				throw new Error('Slot cleanup unavailable');
			}
			return execute(query);
		});
		await expect(repository.delete(guildId, 101n)).rejects.toThrow('Slot cleanup unavailable');
		expect(await repository.get(guildId, 101n)).toBeNull();
		expect(await repository.listSlot(rosterSlotOf(guildId), null, 10)).toHaveLength(1);
		vi.restoreAllMocks();
		await repository.delete(guildId, 101n);
		expect(await repository.listSlot(rosterSlotOf(guildId), null, 10)).toEqual([]);
	});
	it('delete preserves the slot when the event changes identity before the conditional delete', async () => {
		await repository.create(row());
		const replacement = row({created_at: new Date('2026-10-02T11:00:00Z')});
		const execute = executor.executeQuery.bind(executor);
		vi.spyOn(executor, 'executeQuery').mockImplementation(async (query) => {
			if (query.kvMeta?.action === 'delete' && query.kvMeta.table.name === 'guild_roster_events') {
				await repository.create(replacement);
			}
			return execute(query);
		});
		await expect(repository.delete(guildId, 101n)).rejects.toThrow(ConflictError);
		expect(await repository.get(guildId, 101n)).toEqual(replacement);
		expect(await repository.listSlot(rosterSlotOf(guildId), null, 10)).toHaveLength(1);
	});
	it('listSlot pages by guild then event', async () => {
		for (const entry of [
			row({guild_id: otherGuild, event_id: 1n}),
			row({event_id: 102n}),
			row(),
			row({guild_id: createGuildID(12346n << 22n)}),
		])
			await repository.create(entry);
		const first = await repository.listSlot(rosterSlotOf(guildId), null, 1);
		expect(first.map(({guild_id, event_id}) => [guild_id, event_id])).toEqual([[guildId, 101n]]);
		const next = await repository.listSlot(rosterSlotOf(guildId), {guildId, eventId: 101n}, 2);
		expect(next.map(({guild_id, event_id}) => [guild_id, event_id])).toEqual([
			[guildId, 102n],
			[otherGuild, 1n],
		]);
		expect(await repository.listSlot(rosterSlotOf(guildId), {guildId: otherGuild, eventId: 1n}, 2)).toEqual([]);
	});
});
