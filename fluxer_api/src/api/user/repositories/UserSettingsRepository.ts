// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {deleteOneOrMany, executeConditional, fetchMany, fetchOne} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import {buildPatchFromData, executeVersionedUpdate} from '@app/api/database/CassandraVersionedUpdate';
import type {UserGuildSettingsRow, UserSettingsRow} from '@app/api/database/types/UserTypes';
import {USER_GUILD_SETTINGS_COLUMNS, USER_SETTINGS_COLUMNS} from '@app/api/database/types/UserTypes';
import {Logger} from '@app/api/Logger';
import {UserGuildSettings} from '@app/api/models/UserGuildSettings';
import {UserSettings} from '@app/api/models/UserSettings';
import {UserGuildSettings as UserGuildSettingsTable, UserSettings as UserSettingsTable} from '@app/api/Tables';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';

export interface UserSettingsPatchOptions {
	gameActivityPolicyChanged?: boolean;
	expectedPolicyRevision?: bigint;
}

const FETCH_USER_SETTINGS_CQL = UserSettingsTable.selectCql({
	where: UserSettingsTable.where.eq('user_id'),
	limit: 1,
});
const FETCH_USER_GUILD_SETTINGS_CQL = UserGuildSettingsTable.selectCql({
	where: [UserGuildSettingsTable.where.eq('user_id'), UserGuildSettingsTable.where.eq('guild_id')],
	limit: 1,
});
const FETCH_ALL_USER_GUILD_SETTINGS_CQL = UserGuildSettingsTable.selectCql({
	where: UserGuildSettingsTable.where.eq('user_id'),
});

export class UserSettingsRepository {
	async deleteAllUserGuildSettings(userId: UserID): Promise<void> {
		await deleteOneOrMany(
			UserGuildSettingsTable.deleteCql({
				where: UserGuildSettingsTable.where.eq('user_id'),
			}),
			{user_id: userId},
		);
	}

	async deleteGuildSettings(userId: UserID, guildId: GuildID): Promise<void> {
		await deleteOneOrMany(
			UserGuildSettingsTable.deleteByPk({
				user_id: userId,
				guild_id: guildId,
			}),
		);
	}

	async deleteUserSettings(userId: UserID): Promise<void> {
		await deleteOneOrMany(UserSettingsTable.deleteByPk({user_id: userId}));
	}

	async findGuildSettings(userId: UserID, guildId: GuildID | null): Promise<UserGuildSettings | null> {
		const settings = await fetchOne<UserGuildSettingsRow>(FETCH_USER_GUILD_SETTINGS_CQL, {
			user_id: userId,
			guild_id: guildId ? guildId : 0n,
		});
		return settings ? new UserGuildSettings(settings) : null;
	}

	async findAllGuildSettings(userId: UserID): Promise<Array<UserGuildSettings>> {
		const rows = await fetchMany<UserGuildSettingsRow>(FETCH_ALL_USER_GUILD_SETTINGS_CQL, {
			user_id: userId,
		});
		return rows.map((row) => new UserGuildSettings(row));
	}

	async findSettings(userId: UserID, options?: {authoritative?: boolean}): Promise<UserSettings | null> {
		const settings = options?.authoritative
			? (await fetchMany<UserSettingsRow>(FETCH_USER_SETTINGS_CQL, {user_id: userId}, {consistency: 'serial'}))[0]
			: await fetchOne<UserSettingsRow>(FETCH_USER_SETTINGS_CQL, {user_id: userId});
		return settings ? new UserSettings(settings) : null;
	}

	async upsertGuildSettings(settings: UserGuildSettingsRow): Promise<UserGuildSettings> {
		const userId = settings.user_id;
		const guildId = settings.guild_id;
		const result = await executeVersionedUpdate<UserGuildSettingsRow, 'user_id' | 'guild_id'>(
			() =>
				this.findGuildSettings(userId, guildId)
					.then((s) => s?.toRow() ?? null)
					.catch((error) => {
						Logger.error(
							{userId: userId.toString(), guildId: guildId.toString(), error},
							'Failed to fetch guild settings',
						);
						throw error;
					}),
			(current) => ({
				pk: {user_id: userId, guild_id: guildId},
				patch: buildPatchFromData(settings, current, USER_GUILD_SETTINGS_COLUMNS, ['user_id', 'guild_id']),
			}),
			UserGuildSettingsTable,
		);
		return new UserGuildSettings({...settings, version: result.finalVersion ?? 1});
	}

	async upsertSettings(settings: UserSettingsRow): Promise<UserSettings> {
		const userId = settings.user_id;
		const current = await this.findSettings(userId, {authoritative: true});
		if (!current) {
			if (await executeConditional(UserSettingsTable.insertIfNotExists(settings))) return new UserSettings(settings);
		}
		// Full-row callers can carry old policy snapshots. Sharing changes require an explicit fenced patch.
		const {
			user_id: _userId,
			version: _version,
			profile_privacy: _privacy,
			game_activity_visibility: _visibility,
			game_activity_policy_revision: _revision,
			game_activity_visibility_source: _source,
			...patch
		} = settings;
		const profileChanged =
			current && settings.version === current.version && settings.profile_privacy !== current.profilePrivacy;
		return this.writeSettingsPatch(
			userId,
			{...patch, ...(profileChanged ? {profile_privacy: settings.profile_privacy} : {})},
			profileChanged ? settings.version : undefined,
		);
	}

	async patchSettings(
		userId: UserID,
		data: Partial<Omit<UserSettingsRow, 'user_id' | 'version' | 'game_activity_policy_revision'>>,
		options?: UserSettingsPatchOptions,
	): Promise<UserSettings> {
		return this.writeSettingsPatch(userId, data, undefined, options);
	}

	private async writeSettingsPatch(
		userId: UserID,
		data: Partial<Omit<UserSettingsRow, 'user_id' | 'version' | 'game_activity_policy_revision'>>,
		profileSourceVersion?: number,
		options?: UserSettingsPatchOptions,
	): Promise<UserSettings> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await this.findSettings(userId, {authoritative: true});
			if (!current) throw new UnknownUserError();
			if (
				options?.expectedPolicyRevision !== undefined &&
				current.gameActivityPolicyRevision !== options.expectedPolicyRevision
			)
				throw new ServiceUnavailableError();
			const row = current.toRow();
			const intent = {...data};
			if (profileSourceVersion !== undefined) {
				if (current.version !== profileSourceVersion) delete intent.profile_privacy;
				else if (
					(current.gameActivityVisibility ?? 'off') !== 'off' ||
					current.gameActivityVisibilitySource === 'default'
				)
					throw new ServiceUnavailableError();
			}
			const patch = buildPatchFromData<UserSettingsRow>(intent, row, USER_SETTINGS_COLUMNS, ['user_id']);
			const policyChanged =
				options?.gameActivityPolicyChanged === true ||
				patch.game_activity_visibility !== undefined ||
				patch.game_activity_visibility_source !== undefined ||
				patch.profile_privacy !== undefined;
			const revision = current.gameActivityPolicyRevision;
			if (policyChanged && revision >= 9223372036854775807n) throw new ServiceUnavailableError();
			if (policyChanged) patch.game_activity_policy_revision = Db.set(revision + 1n);
			patch.version = Db.set(current.version + 1);
			const applied = await executeConditional(
				UserSettingsTable.conditionalPatchByPk({user_id: userId}, patch, {
					version: current.version,
					game_activity_policy_revision: row.game_activity_policy_revision ?? null,
				}),
			);
			if (applied) {
				const updated = await this.findSettings(userId, {authoritative: true});
				if (!updated) throw new UnknownUserError();
				return updated;
			}
		}
		throw new ServiceUnavailableError();
	}
}
