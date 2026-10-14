// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID} from '@app/api/BrandedTypes';
import {
	BatchBuilder,
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {
	type GuildRosterEventBySlotRow,
	type GuildRosterEventRow,
	rosterSlotOf,
} from '@app/api/database/types/GuildRosterTypes';
import {GuildRosterEvents, GuildRosterEventsBySlot} from '@app/api/guild/roster/GuildRosterTables';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';

const LIST_BY_GUILD = GuildRosterEvents.select({where: GuildRosterEvents.where.eq('guild_id')});
const GET_EVENT = GuildRosterEvents.select({
	where: [GuildRosterEvents.where.eq('guild_id'), GuildRosterEvents.where.eq('event_id')],
	limit: 1,
});

export class GuildRosterRepository {
	async listByGuild(guildId: GuildID): Promise<Array<GuildRosterEventRow>> {
		return fetchMany<GuildRosterEventRow>(LIST_BY_GUILD.bind({guild_id: guildId}));
	}

	async get(guildId: GuildID, eventId: bigint): Promise<GuildRosterEventRow | null> {
		return fetchOne<GuildRosterEventRow>(GET_EVENT.bind({guild_id: guildId, event_id: eventId}));
	}

	async create(row: GuildRosterEventRow): Promise<void> {
		await new BatchBuilder()
			.addPrepared(GuildRosterEvents.upsertAll(row))
			.addPrepared(
				GuildRosterEventsBySlot.upsertAll({
					slot: rosterSlotOf(row.guild_id),
					guild_id: row.guild_id,
					event_id: row.event_id,
				}),
			)
			.execute();
	}

	async update(row: GuildRosterEventRow, expectedVersion: number): Promise<boolean> {
		return executeConditional(
			GuildRosterEvents.conditionalPatchByPk(
				{guild_id: row.guild_id, event_id: row.event_id},
				{
					name: Db.set(row.name),
					voice_channel_id: Db.set(row.voice_channel_id),
					announce_channel_id: Db.set(row.announce_channel_id),
					mention_role_id: row.mention_role_id === null ? Db.clear() : Db.set(row.mention_role_id),
					main_size: Db.set(row.main_size),
					sub_size: Db.set(row.sub_size),
					enabled: Db.set(row.enabled),
					created_by: Db.set(row.created_by),
					created_at: Db.set(row.created_at),
					updated_at: Db.set(row.updated_at),
					version: Db.set(expectedVersion + 1),
				},
				{version: expectedVersion},
			),
		);
	}

	async delete(guildId: GuildID, eventId: bigint): Promise<void> {
		const current = await this.get(guildId, eventId);
		if (current) {
			// Keep deletion in the same Paxos path as updates; created_at is immutable across version changes.
			const deleted = await executeConditional(
				GuildRosterEvents.conditionalDeleteByPk(
					{guild_id: guildId, event_id: eventId},
					{created_at: current.created_at},
				),
			);
			if (!deleted && (await this.get(guildId, eventId)) !== null) {
				throw new ConflictError({code: APIErrorCodes.CONFLICT});
			}
		}
		// TEMPORARY: without a DELETE retry, a crash can leave a slot permanently; slot walks only ignore it.
		// Add bounded slot reconciliation when stale slots are reported or a slot partition exceeds 5000 rows.
		await deleteOneOrMany(
			GuildRosterEventsBySlot.deleteByPk({slot: rosterSlotOf(guildId), guild_id: guildId, event_id: eventId}),
		);
	}

	async listSlot(
		slot: number,
		after: {guildId: GuildID; eventId: bigint} | null,
		limit: number,
	): Promise<Array<GuildRosterEventBySlotRow>> {
		const where = [GuildRosterEventsBySlot.where.eq('slot')];
		if (after)
			where.push(GuildRosterEventsBySlot.where.tupleGt(['guild_id', 'event_id'], ['after_guild_id', 'after_event_id']));
		return fetchMany<GuildRosterEventBySlotRow>(
			GuildRosterEventsBySlot.select({where, orderBy: {col: 'guild_id', direction: 'ASC'}, limit}).bind(
				after ? {slot, after_guild_id: after.guildId, after_event_id: after.eventId} : {slot},
			),
		);
	}
}
