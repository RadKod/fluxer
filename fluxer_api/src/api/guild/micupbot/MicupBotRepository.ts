// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, MessageID, UserID} from '@app/api/BrandedTypes';
import {
	BatchBuilder,
	executeConditional,
	fetchMany,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {
	type MicupBotAutomodRuleRow,
	type MicupBotGuildSettingsRow,
	type MicupBotLevelRewardRow,
	type MicupBotMemberLevelRow,
	type MicupBotReactionRolePanelRow,
	type MicupBotUserGuildRow,
	type MicupBotVoiceGuildBySlotRow,
	type MicupBotWarningRow,
	micupBotLevelBucket,
	micupBotSlotOf,
} from '@app/api/database/types/MicupBotTypes';
import {
	MicupBotMemberLevels as Levels,
	MicupBotReactionRolePanels as Panels,
	MicupBotLevelRewards as Rewards,
	MicupBotAutomodRules as Rules,
	MicupBotGuildSettings as Settings,
	MicupBotUserGuilds as UserGuilds,
	MicupBotVoiceGuildsBySlot as Voice,
	MicupBotWarnings as Warnings,
} from '@app/api/guild/micupbot/MicupBotTables';

export class MicupBotRepository {
	async getSettings(guildId: GuildID): Promise<MicupBotGuildSettingsRow | null> {
		return fetchOne<MicupBotGuildSettingsRow>(
			Settings.select({where: Settings.where.eq('guild_id'), limit: 1}).bind({guild_id: guildId}),
		);
	}
	async putSettings(row: MicupBotGuildSettingsRow, expectedVersion: number | null): Promise<boolean> {
		if (expectedVersion === null) return executeConditional(Settings.insertIfNotExists({...row, version: 0}));
		const patch = Object.fromEntries(
			Settings.columns.filter((k) => k !== 'guild_id').map((k) => [k, row[k] === null ? Db.clear() : Db.set(row[k])]),
		) as Parameters<typeof Settings.conditionalPatchByPk>[1];
		patch.version = Db.set(expectedVersion + 1);
		return executeConditional(
			Settings.conditionalPatchByPk({guild_id: row.guild_id}, patch, {version: expectedVersion}),
		);
	}
	async listRules(guildId: GuildID): Promise<Array<MicupBotAutomodRuleRow>> {
		return fetchMany<MicupBotAutomodRuleRow>(
			Rules.select({where: Rules.where.eq('guild_id')}).bind({guild_id: guildId}),
		);
	}
	async replaceRules(guildId: GuildID, rows: Array<MicupBotAutomodRuleRow>): Promise<void> {
		const batch = new BatchBuilder();
		const names = new Set(rows.map((r) => r.rule));
		for (const row of await this.listRules(guildId))
			if (!names.has(row.rule)) batch.addPrepared(Rules.deleteByPk({guild_id: guildId, rule: row.rule}));
		for (const row of rows) batch.addPrepared(Rules.upsertAll({...row, guild_id: guildId}));
		await batch.execute();
	}
	async listPanels(guildId: GuildID): Promise<Array<MicupBotReactionRolePanelRow>> {
		return fetchMany<MicupBotReactionRolePanelRow>(
			Panels.select({where: Panels.where.eq('guild_id')}).bind({guild_id: guildId}),
		);
	}
	async getPanel(guildId: GuildID, messageId: MessageID): Promise<MicupBotReactionRolePanelRow | null> {
		return fetchOne<MicupBotReactionRolePanelRow>(
			Panels.select({where: [Panels.where.eq('guild_id'), Panels.where.eq('message_id')], limit: 1}).bind({
				guild_id: guildId,
				message_id: messageId,
			}),
		);
	}
	async putPanel(row: MicupBotReactionRolePanelRow): Promise<void> {
		await upsertOne(Panels.upsertAll(row));
	}
	async deletePanel(guildId: GuildID, messageId: MessageID): Promise<void> {
		await upsertOne(Panels.deleteByPk({guild_id: guildId, message_id: messageId}));
	}
	async listRewards(guildId: GuildID): Promise<Array<MicupBotLevelRewardRow>> {
		return fetchMany<MicupBotLevelRewardRow>(
			Rewards.select({where: Rewards.where.eq('guild_id'), orderBy: {col: 'level', direction: 'ASC'}}).bind({
				guild_id: guildId,
			}),
		);
	}
	async replaceRewards(guildId: GuildID, rows: Array<MicupBotLevelRewardRow>): Promise<void> {
		const batch = new BatchBuilder();
		const levels = new Set(rows.map((r) => r.level));
		for (const row of await this.listRewards(guildId))
			if (!levels.has(row.level)) batch.addPrepared(Rewards.deleteByPk({guild_id: guildId, level: row.level}));
		for (const row of rows) batch.addPrepared(Rewards.upsertAll({...row, guild_id: guildId}));
		await batch.execute();
	}
	async getMemberXp(guildId: GuildID, userId: UserID): Promise<bigint | null> {
		const row = await fetchOne<MicupBotMemberLevelRow>(
			Levels.select({
				where: [Levels.where.eq('guild_id'), Levels.where.eq('bucket'), Levels.where.eq('user_id')],
				limit: 1,
			}).bind({guild_id: guildId, bucket: micupBotLevelBucket(userId), user_id: userId}),
		);
		return row?.xp ?? null;
	}
	async setMemberXp(guildId: GuildID, userId: UserID, xp: bigint): Promise<void> {
		await upsertOne(
			Levels.upsertAll({
				guild_id: guildId,
				bucket: micupBotLevelBucket(userId),
				user_id: userId,
				xp,
				updated_at: new Date(),
			}),
		);
	}
	async deleteMemberLevel(guildId: GuildID, userId: UserID): Promise<void> {
		await upsertOne(Levels.deleteByPk({guild_id: guildId, bucket: micupBotLevelBucket(userId), user_id: userId}));
	}
	async listMemberLevelsPage(
		guildId: GuildID,
		bucket: number,
		afterUserId: UserID | null,
		limit: number,
	): Promise<Array<{userId: UserID; xp: bigint}>> {
		const where = [Levels.where.eq('guild_id'), Levels.where.eq('bucket')];
		if (afterUserId !== null) where.push(Levels.where.gt('user_id', 'after_user_id'));
		const rows = await fetchMany<MicupBotMemberLevelRow>(
			Levels.select({where, orderBy: {col: 'user_id', direction: 'ASC'}, limit}).bind({
				guild_id: guildId,
				bucket,
				...(afterUserId === null ? {} : {after_user_id: afterUserId}),
			}),
		);
		return rows.map((r) => ({userId: r.user_id, xp: r.xp}));
	}
	async listWarnings(guildId: GuildID, userId: UserID, limit: number): Promise<Array<MicupBotWarningRow>> {
		return fetchMany<MicupBotWarningRow>(
			Warnings.select({
				where: [Warnings.where.eq('guild_id'), Warnings.where.eq('user_id')],
				orderBy: {col: 'warning_id', direction: 'DESC'},
				limit: Math.min(100, limit),
			}).bind({guild_id: guildId, user_id: userId}),
		);
	}
	async countWarnings(guildId: GuildID, userId: UserID): Promise<number> {
		return (
			await fetchMany<Pick<MicupBotWarningRow, 'warning_id'>>(
				Warnings.select({
					columns: ['warning_id'],
					where: [Warnings.where.eq('guild_id'), Warnings.where.eq('user_id')],
					limit: 101,
				}).bind({guild_id: guildId, user_id: userId}),
			)
		).length;
	}
	async addWarning(row: MicupBotWarningRow): Promise<void> {
		await new BatchBuilder()
			.addPrepared(Warnings.upsertAll(row))
			.addPrepared(UserGuilds.upsertAll({user_id: row.user_id, guild_id: row.guild_id, updated_at: row.created_at}))
			.execute();
	}
	async deleteWarning(guildId: GuildID, userId: UserID, warningId: bigint): Promise<boolean> {
		const key = {guild_id: guildId, user_id: userId, warning_id: warningId};
		const row = await fetchOne<MicupBotWarningRow>(
			Warnings.select({
				where: [Warnings.where.eq('guild_id'), Warnings.where.eq('user_id'), Warnings.where.eq('warning_id')],
				limit: 1,
			}).bind(key),
		);
		if (!row) return false;
		await upsertOne(Warnings.deleteByPk(key));
		return true;
	}
	async deleteWarnings(guildId: GuildID, userId: UserID): Promise<void> {
		await upsertOne(Warnings.deletePartition({guild_id: guildId, user_id: userId}));
	}
	async setVoiceGuild(guildId: GuildID, enabled: boolean): Promise<void> {
		const key = {slot: micupBotSlotOf(guildId), guild_id: guildId};
		await upsertOne(enabled ? Voice.upsertAll(key) : Voice.deleteByPk(key));
	}
	async listVoiceSlot(slot: number, afterGuildId: GuildID | null, limit: number): Promise<Array<GuildID>> {
		const where = [Voice.where.eq('slot')];
		if (afterGuildId !== null) where.push(Voice.where.gt('guild_id', 'after_guild_id'));
		return (
			await fetchMany<MicupBotVoiceGuildBySlotRow>(
				Voice.select({where, orderBy: {col: 'guild_id', direction: 'ASC'}, limit}).bind({
					slot,
					...(afterGuildId === null ? {} : {after_guild_id: afterGuildId}),
				}),
			)
		).map((r) => r.guild_id);
	}
	async addUserGuild(userId: UserID, guildId: GuildID): Promise<void> {
		await upsertOne(UserGuilds.upsertAll({user_id: userId, guild_id: guildId, updated_at: new Date()}));
	}
	async listUserGuilds(userId: UserID): Promise<Array<GuildID>> {
		return (
			await fetchMany<MicupBotUserGuildRow>(
				UserGuilds.select({where: UserGuilds.where.eq('user_id'), orderBy: {col: 'guild_id', direction: 'ASC'}}).bind({
					user_id: userId,
				}),
			)
		).map((r) => r.guild_id);
	}
	async deleteUserGuilds(userId: UserID): Promise<void> {
		await upsertOne(UserGuilds.deletePartition({user_id: userId}));
	}
}
