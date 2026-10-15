// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {
	GuildBoostRow,
	GuildBoostStateRow,
	GuildEntitlementExpirationRow,
	UserBoostSlotRow,
} from '@app/api/database/types/GuildBoostTypes';
import type {GuildRow} from '@app/api/database/types/GuildTypes';
import {
	GuildBoostState,
	GuildBoosts,
	GuildEntitlementExpirations,
	UserBoostSlots,
} from '@app/api/guild/boost/GuildBoostTables';
import {Guilds} from '@app/api/Tables';

const FETCH_SLOT_CQL = UserBoostSlots.selectCql({
	where: [UserBoostSlots.where.eq('user_id'), UserBoostSlots.where.eq('slot_id')],
	limit: 1,
});
// TEMPORARY: a user holds its premium slots (2 by default) and nothing else yet, so the partition is read whole. Page it
// once store-bought slots let one account hold more than a few hundred.
const LIST_SLOTS_CQL = UserBoostSlots.selectCql({where: UserBoostSlots.where.eq('user_id')});
const FETCH_BOOST_CQL = GuildBoosts.selectCql({
	where: [GuildBoosts.where.eq('guild_id'), GuildBoosts.where.eq('boost_id')],
	limit: 1,
});
const FETCH_STATE_CQL = GuildBoostState.selectCql({where: GuildBoostState.where.eq('guild_id'), limit: 1});
const FETCH_BOOST_COUNT_CQL = Guilds.selectCql({
	columns: ['premium_subscription_count'],
	where: Guilds.where.eq('guild_id'),
	limit: 1,
});

function listBoostsNewestQuery(limit: number, before: boolean) {
	return GuildBoosts.select({
		where: before
			? [GuildBoosts.where.eq('guild_id'), GuildBoosts.where.lt('boost_id')]
			: [GuildBoosts.where.eq('guild_id')],
		orderBy: {col: 'boost_id', direction: 'DESC'},
		limit,
	});
}

function listBoostsAfterQuery(limit: number, after: boolean) {
	return GuildBoosts.select({
		where: after
			? [GuildBoosts.where.eq('guild_id'), GuildBoosts.where.gt('boost_id')]
			: [GuildBoosts.where.eq('guild_id')],
		limit,
	});
}

function listExpirationsQuery(limit: number, after: boolean) {
	const where = [GuildEntitlementExpirations.where.eq('day'), GuildEntitlementExpirations.where.eq('shard')];
	if (after) {
		where.push(
			GuildEntitlementExpirations.where.tupleGt(
				['guild_id', 'entitlement_id'],
				['after_guild_id', 'after_entitlement_id'],
			),
		);
	}
	return GuildEntitlementExpirations.select({where, limit});
}

export class GuildBoostRepository {
	async getSlot(userId: UserID, slotId: string): Promise<UserBoostSlotRow | null> {
		return fetchOne<UserBoostSlotRow>(FETCH_SLOT_CQL, {user_id: userId, slot_id: slotId});
	}

	async listSlots(userId: UserID): Promise<Array<UserBoostSlotRow>> {
		return fetchMany<UserBoostSlotRow>(LIST_SLOTS_CQL, {user_id: userId});
	}

	// A slot is created free at version 1 and never overwritten, since the CAS below needs a non-null expected value.
	async createSlotIfAbsent(userId: UserID, slotId: string, source: string): Promise<void> {
		await executeConditional(
			UserBoostSlots.insertIfNotExists({
				user_id: userId,
				slot_id: slotId,
				guild_id: null,
				boost_id: null,
				source,
				assigned_at: null,
				version: 1,
			}),
		);
	}

	async claimSlot(slot: UserBoostSlotRow, claim: {guildId: GuildID; boostId: bigint; at: Date}): Promise<boolean> {
		return executeConditional(
			UserBoostSlots.conditionalPatchByPk(
				{user_id: slot.user_id, slot_id: slot.slot_id},
				{
					guild_id: Db.set(claim.guildId),
					boost_id: Db.set(claim.boostId),
					assigned_at: Db.set(claim.at),
					version: Db.set(slot.version + 1),
				},
				{version: slot.version},
			),
		);
	}

	// Keeps assigned_at: the move cooldown counts from the last time the slot was put on a guild.
	async freeSlot(slot: UserBoostSlotRow): Promise<boolean> {
		return executeConditional(
			UserBoostSlots.conditionalPatchByPk(
				{user_id: slot.user_id, slot_id: slot.slot_id},
				{guild_id: Db.clear(), boost_id: Db.clear(), version: Db.set(slot.version + 1)},
				{version: slot.version},
			),
		);
	}

	async deleteSlots(userId: UserID): Promise<void> {
		await deleteOneOrMany(UserBoostSlots.deletePartition({user_id: userId}));
	}

	async getBoost(guildId: GuildID, boostId: bigint): Promise<GuildBoostRow | null> {
		return fetchOne<GuildBoostRow>(FETCH_BOOST_CQL, {guild_id: guildId, boost_id: boostId});
	}

	async putBoost(row: GuildBoostRow): Promise<void> {
		await upsertOne(GuildBoosts.insert(row));
	}

	async deleteBoost(guildId: GuildID, boostId: bigint): Promise<void> {
		await deleteOneOrMany(GuildBoosts.deleteByPk({guild_id: guildId, boost_id: boostId}));
	}

	async listBoostsNewestFirst(guildId: GuildID, limit: number, before?: bigint): Promise<Array<GuildBoostRow>> {
		if (before === undefined) {
			return fetchMany<GuildBoostRow>(listBoostsNewestQuery(limit, false).bind({guild_id: guildId}));
		}
		return fetchMany<GuildBoostRow>(listBoostsNewestQuery(limit, true).bind({guild_id: guildId, boost_id: before}));
	}

	async listBoostsAfter(guildId: GuildID, limit: number, after?: bigint): Promise<Array<GuildBoostRow>> {
		if (after === undefined) {
			return fetchMany<GuildBoostRow>(listBoostsAfterQuery(limit, false).bind({guild_id: guildId}));
		}
		return fetchMany<GuildBoostRow>(listBoostsAfterQuery(limit, true).bind({guild_id: guildId, boost_id: after}));
	}

	async getState(guildId: GuildID): Promise<GuildBoostStateRow | null> {
		return fetchOne<GuildBoostStateRow>(FETCH_STATE_CQL, {guild_id: guildId});
	}

	// Only the recompute writes it, under the guild update lock, so a plain upsert has a single writer.
	async putState(row: GuildBoostStateRow): Promise<void> {
		await upsertOne(GuildBoostState.upsertAll({...row, pending_feature_changes: row.pending_feature_changes ?? null}));
	}

	async addExpiration(row: GuildEntitlementExpirationRow): Promise<void> {
		await upsertOne(GuildEntitlementExpirations.insert(row));
	}

	async deleteExpiration(row: GuildEntitlementExpirationRow): Promise<void> {
		await deleteOneOrMany(GuildEntitlementExpirations.deleteByPk(row));
	}

	async listExpirations(
		day: number,
		shard: number,
		limit: number,
		after?: Pick<GuildEntitlementExpirationRow, 'guild_id' | 'entitlement_id'>,
	): Promise<Array<GuildEntitlementExpirationRow>> {
		if (after === undefined) {
			return fetchMany<GuildEntitlementExpirationRow>(listExpirationsQuery(limit, false).bind({day, shard}));
		}
		return fetchMany<GuildEntitlementExpirationRow>(
			listExpirationsQuery(limit, true).bind({
				day,
				shard,
				after_guild_id: after.guild_id,
				after_entitlement_id: after.entitlement_id,
			}),
		);
	}

	/** Stored premium_subscription_count (a null column reads as 0), or null when the guild row does not exist. */
	async findBoostCount(guildId: GuildID): Promise<number | null> {
		const row = await fetchOne<Pick<GuildRow, 'premium_subscription_count'>>(FETCH_BOOST_COUNT_CQL, {
			guild_id: guildId,
		});
		return row ? (row.premium_subscription_count ?? 0) : null;
	}

	/** Writes only premium_subscription_count (no read, no version bump); callers check the guild exists first. */
	async setBoostCount(guildId: GuildID, count: number): Promise<void> {
		await upsertOne(Guilds.patchByPk({guild_id: guildId}, {premium_subscription_count: Db.set(count)}));
	}
}
