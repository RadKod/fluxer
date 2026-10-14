// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	applicationIdToUserId,
	createChannelID,
	createGuildID,
	createRoleID,
	type GuildID,
	type UserID,
} from '@app/api/BrandedTypes';
import type {GuildRosterEventRow} from '@app/api/database/types/GuildRosterTypes';
import {isGuildRosterLive, rosterBotApplicationId} from '@app/api/guild/roster/GuildRosterBot';
import {ROSTER_BOT_INVITE_PERMISSIONS} from '@app/api/guild/roster/GuildRosterConstants';
import type {GuildRosterRepository} from '@app/api/guild/roster/GuildRosterRepository';
import {Logger} from '@app/api/Logger';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {MaxGuildRosterEventsError} from '@fluxer/errors/src/domains/guild/MaxGuildRosterEventsError';
import {UnknownGuildRosterEventError} from '@fluxer/errors/src/domains/guild/UnknownGuildRosterEventError';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {
	GUILD_ROSTER_LIMITS,
	type GuildRosterEventCreateRequest,
	type GuildRosterEventUpdateRequest,
} from '@fluxer/schema/src/domains/roster/GuildRosterRequestSchemas';
import type {
	GuildRosterEventListResponse,
	GuildRosterEventResponse,
} from '@fluxer/schema/src/domains/roster/GuildRosterResponseSchemas';

export type GuildRosterSettingsDependencies = Pick<
	WorkerDependencies,
	'limitConfigService' | 'snowflakeService' | 'gatewayService' | 'guildRepository' | 'channelRepository'
> & {repository: GuildRosterRepository};
export interface GuildRosterSettingsContext {
	guild: GuildResponse;
	userId: UserID;
}

export class GuildRosterSettingsService {
	constructor(private readonly deps: GuildRosterSettingsDependencies) {}

	async list({guild}: GuildRosterSettingsContext): Promise<GuildRosterEventListResponse> {
		const guildId = createGuildID(BigInt(guild.id));
		const applicationId = rosterBotApplicationId();
		const botUserId = applicationId === null ? null : applicationIdToUserId(applicationId);
		const events = await this.deps.repository.listByGuild(guildId);
		return {
			feature_enabled: isGuildRosterLive(this.deps.limitConfigService),
			bot:
				applicationId !== null && botUserId !== null
					? {
							application_id: applicationId.toString(),
							user_id: botUserId.toString(),
							in_guild: (await this.deps.guildRepository.getMember(guildId, botUserId)) !== null,
						}
					: null,
			invite_permissions:
				ROSTER_BOT_INVITE_PERMISSIONS.toString() as GuildRosterEventListResponse['invite_permissions'],
			max_events: GUILD_ROSTER_LIMITS.maxEvents,
			events: events
				.sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0))
				.map((row) => this.toResponse(row)),
		};
	}

	async create({
		guild,
		userId,
		data,
	}: GuildRosterSettingsContext & {data: GuildRosterEventCreateRequest}): Promise<GuildRosterEventResponse> {
		this.requireLive();
		const guildId = createGuildID(BigInt(guild.id));
		const count = (await this.deps.repository.listByGuild(guildId)).length;
		this.warnOverLimit(guildId, count);
		if (count >= GUILD_ROSTER_LIMITS.maxEvents) throw new MaxGuildRosterEventsError(GUILD_ROSTER_LIMITS.maxEvents);
		const now = new Date();
		const row: GuildRosterEventRow = {
			...data,
			guild_id: guildId,
			event_id: await this.deps.snowflakeService.generate(),
			voice_channel_id: createChannelID(data.voice_channel_id),
			announce_channel_id: createChannelID(data.announce_channel_id),
			mention_role_id: data.mention_role_id == null ? null : createRoleID(data.mention_role_id),
			created_by: userId,
			created_at: now,
			updated_at: now,
			version: 0,
		};
		await this.validateEvent(row, userId);
		// TEMPORARY: the 10-event cap is soft; concurrent creates can reach 11. Any over-limit warning
		// triggers migration to a per-guild LWT counter.
		await this.deps.repository.create(row);
		this.warnOverLimit(guildId, (await this.deps.repository.listByGuild(guildId)).length);
		return this.toResponse(row);
	}

	async update({
		guild,
		userId,
		eventId,
		data,
	}: GuildRosterSettingsContext & {
		eventId: bigint;
		data: GuildRosterEventUpdateRequest;
	}): Promise<GuildRosterEventResponse> {
		this.requireLive();
		const guildId = createGuildID(BigInt(guild.id));
		for (let attempt = 0; attempt < 2; attempt++) {
			const current = await this.getEvent(guildId, eventId);
			const row: GuildRosterEventRow = {
				...current,
				name: data.name ?? current.name,
				voice_channel_id:
					data.voice_channel_id === undefined ? current.voice_channel_id : createChannelID(data.voice_channel_id),
				announce_channel_id:
					data.announce_channel_id === undefined
						? current.announce_channel_id
						: createChannelID(data.announce_channel_id),
				mention_role_id:
					data.mention_role_id === undefined
						? current.mention_role_id
						: data.mention_role_id === null
							? null
							: createRoleID(data.mention_role_id),
				main_size: data.main_size ?? current.main_size,
				sub_size: data.sub_size ?? current.sub_size,
				enabled: data.enabled ?? current.enabled,
				updated_at: new Date(),
			};
			await this.validateEvent(row, userId);
			if (await this.deps.repository.update(row, current.version)) return this.toResponse(row);
		}
		throw new ConflictError({code: APIErrorCodes.CONFLICT});
	}

	async delete({guild, eventId}: GuildRosterSettingsContext & {eventId: bigint}): Promise<void> {
		this.requireLive();
		const guildId = createGuildID(BigInt(guild.id));
		const current = await this.deps.repository.get(guildId, eventId);
		await this.deps.repository.delete(guildId, eventId);
		if (!current) throw new UnknownGuildRosterEventError();
	}

	private requireLive(): void {
		if (!isGuildRosterLive(this.deps.limitConfigService)) throw new FeatureTemporarilyDisabledError();
	}

	private async getEvent(guildId: GuildID, eventId: bigint): Promise<GuildRosterEventRow> {
		const row = await this.deps.repository.get(guildId, eventId);
		if (!row) throw new UnknownGuildRosterEventError();
		return row;
	}

	private warnOverLimit(guildId: GuildID, count: number): void {
		if (count > GUILD_ROSTER_LIMITS.maxEvents) {
			Logger.warn(
				{guild_id: guildId.toString(), count, max_events: GUILD_ROSTER_LIMITS.maxEvents},
				'Guild roster event limit exceeded',
			);
		}
	}

	private async validateEvent(row: GuildRosterEventRow, userId: UserID): Promise<void> {
		const guildId = row.guild_id;
		const [voice, announce] = await Promise.all([
			this.deps.channelRepository.channelData.findUnique(row.voice_channel_id),
			this.deps.channelRepository.channelData.findUnique(row.announce_channel_id),
		]);
		if (!voice || voice.guildId !== guildId) {
			throw InputValidationError.fromCode('voice_channel_id', ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST);
		}
		if (voice.type !== ChannelTypes.GUILD_VOICE) {
			throw InputValidationError.fromCode('voice_channel_id', ValidationErrorCodes.CHANNEL_MUST_BE_VOICE);
		}
		if (!announce || announce.guildId !== guildId) {
			throw InputValidationError.fromCode('announce_channel_id', ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST);
		}
		if (announce.type !== ChannelTypes.GUILD_TEXT) {
			throw InputValidationError.fromCode('announce_channel_id', ValidationErrorCodes.INVALID_CHANNEL_ID);
		}
		let needsMentionPermission = false;
		if (row.mention_role_id !== null) {
			if (BigInt(row.mention_role_id) === BigInt(guildId)) {
				throw InputValidationError.fromCode('mention_role_id', ValidationErrorCodes.INVALID_ROLE_ID);
			}
			const role = await this.deps.guildRepository.getRole(row.mention_role_id, guildId);
			if (!role) throw InputValidationError.fromCode('mention_role_id', ValidationErrorCodes.INVALID_ROLE_ID);
			needsMentionPermission = !role.isMentionable;
		}
		const [voicePermissions, announcePermissions] = await Promise.all([
			this.deps.gatewayService.getUserPermissions({guildId, userId, channelId: row.voice_channel_id}),
			this.deps.gatewayService.getUserPermissions({guildId, userId, channelId: row.announce_channel_id}),
		]);
		const voiceRequired = Permissions.VIEW_CHANNEL | Permissions.CONNECT | Permissions.MOVE_MEMBERS;
		const announceRequired =
			Permissions.VIEW_CHANNEL |
			Permissions.SEND_MESSAGES |
			(needsMentionPermission ? Permissions.MENTION_EVERYONE : 0n);
		if (
			(voicePermissions & voiceRequired) !== voiceRequired ||
			(announcePermissions & announceRequired) !== announceRequired
		) {
			throw new MissingPermissionsError();
		}
	}

	private toResponse(row: GuildRosterEventRow): GuildRosterEventResponse {
		return {
			id: row.event_id.toString(),
			guild_id: row.guild_id.toString(),
			name: row.name,
			voice_channel_id: row.voice_channel_id.toString(),
			announce_channel_id: row.announce_channel_id.toString(),
			mention_role_id: row.mention_role_id?.toString() ?? null,
			main_size: row.main_size,
			sub_size: row.sub_size,
			enabled: row.enabled,
			created_at: row.created_at.toISOString(),
			updated_at: row.updated_at.toISOString(),
		};
	}
}
