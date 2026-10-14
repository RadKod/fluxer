// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ChannelID,
	createChannelID,
	createEmojiID,
	createGuildID,
	createRoleID,
	createUserID,
	type GuildID,
	type MessageID,
	type RoleID,
	type UserID,
} from '@app/api/BrandedTypes';
import type {
	MicupBotAutomodRuleRow,
	MicupBotGuildSettingsRow,
	MicupBotReactionRolePanelRow,
} from '@app/api/database/types/MicupBotTypes';
import {isMicupBotLive, micupBotApplicationId, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {
	MICUPBOT_BOT_INVITE_PERMISSIONS,
	MICUPBOT_EMBED_COLOR,
	MICUPBOT_LIMITS,
	MICUPBOT_MODULE_TOGGLE_COOLDOWN_SECONDS,
	MICUPBOT_TEXT,
} from '@app/api/guild/micupbot/MicupBotConstants';
import {desiredMicupBotFlags, syncMicupBotGuildFlags} from '@app/api/guild/micupbot/MicupBotGuildFlags';
import {leaderboardCount, leaderboardExists, leaderboardTop} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import type {MicupBotRepository} from '@app/api/guild/micupbot/MicupBotRepository';
import {micupBotRoleProblem} from '@app/api/guild/micupbot/MicupBotRoleRules';
import {getMicupBotGuildConfig, invalidateMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {levelFromXp} from '@app/api/guild/micupbot/MicupBotXp';
import {withGuildUpdateLock} from '@app/api/guild/services/GuildService';
import {Logger} from '@app/api/Logger';
import type {RequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures, GuildMFALevel, SystemChannelFlags} from '@fluxer/constants/src/GuildConstants';
import {ValidationErrorCodes} from '@fluxer/constants/src/ValidationErrorCodes';
import {FeatureTemporarilyDisabledError} from '@fluxer/errors/src/domains/core/FeatureTemporarilyDisabledError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {MaxMicupBotReactionRolePanelsError} from '@fluxer/errors/src/domains/guild/MaxMicupBotReactionRolePanelsError';
import {MicupBotNotInGuildError} from '@fluxer/errors/src/domains/guild/MicupBotNotInGuildError';
import {MicupBotRoleNotAssignableError} from '@fluxer/errors/src/domains/guild/MicupBotRoleNotAssignableError';
import {UnknownMicupBotReactionRolePanelError} from '@fluxer/errors/src/domains/guild/UnknownMicupBotReactionRolePanelError';
import {UnknownMicupBotWarningError} from '@fluxer/errors/src/domains/guild/UnknownMicupBotWarningError';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import type {
	MicupBotAutomodUpdateRequest,
	MicupBotLevelRewardsUpdateRequest,
	MicupBotReactionRolePanelCreateRequest,
	MicupBotSettingsUpdateRequest,
} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import {MICUPBOT_AUTOMOD_RULES, MICUPBOT_THRESHOLDS} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
import type {
	MicupBotAutomodResponse,
	MicupBotLeaderboardResponse,
	MicupBotLevelRewardsResponse,
	MicupBotReactionRolePanelListResponse,
	MicupBotReactionRolePanelResponse,
	MicupBotSettingsResponse,
	MicupBotWarningListResponse,
} from '@fluxer/schema/src/domains/micupbot/MicupBotResponseSchemas';
import {isValidSingleUnicodeEmoji} from '@fluxer/schema/src/primitives/EmojiValidators';
export type MicupBotSettingsDependencies = Pick<
	WorkerDependencies,
	| 'guildRepository'
	| 'channelRepository'
	| 'gatewayService'
	| 'limitConfigService'
	| 'cacheService'
	| 'kvClient'
	| 'snowflakeService'
	| 'userCacheService'
	| 'channelService'
	| 'guildService'
	| 'userRepository'
> & {repository: MicupBotRepository; workerService: () => WorkerDependencies['workerService']};
export interface MicupBotSettingsContext {
	guildData: GuildResponse;
	userId: UserID;
}
export class MicupBotSettingsService {
	constructor(readonly deps: MicupBotSettingsDependencies) {}
	async getSettings({guildData, userId}: MicupBotSettingsContext): Promise<MicupBotSettingsResponse> {
		const guildId = createGuildID(BigInt(guildData.id));
		const applicationId = micupBotApplicationId();
		const botId = await this.memberBot(guildId);
		const stored = await this.deps.repository.getSettings(guildId);
		const row = stored ?? this.defaultSettings(guildId, userId);
		const [panels, rewards] = await Promise.all([
			this.deps.repository.listPanels(guildId),
			this.deps.repository.listRewards(guildId),
		]);
		const roleIds = new Set(row.autorole_ids ?? []);
		for (const panel of panels)
			for (const entry of this.panelResponse(panel).entries) roleIds.add(createRoleID(BigInt(entry.role_id)));
		for (const reward of rewards) roleIds.add(reward.role_id);
		return {
			feature_enabled: isMicupBotLive(this.deps.limitConfigService),
			bot:
				applicationId === null
					? null
					: {
							application_id: applicationId.toString(),
							user_id: micupBotUserId()!.toString(),
							in_guild: botId !== null,
							mfa_blocked: guildData.mfa_level === GuildMFALevel.ELEVATED,
						},
			invite_permissions: MICUPBOT_BOT_INVITE_PERMISSIONS.toString() as MicupBotSettingsResponse['invite_permissions'],
			join_notification_conflict:
				row.welcome_enabled &&
				row.welcome_channel_id !== null &&
				row.welcome_channel_id.toString() === guildData.system_channel_id &&
				(guildData.system_channel_flags & SystemChannelFlags.SUPPRESS_JOIN_NOTIFICATIONS) === 0,
			role_warnings: (await this.roleProblems(guildData, userId, botId, [...roleIds])).map(String),
			settings: {
				commands_enabled: row.commands_enabled,
				levels_enabled: row.levels_enabled,
				automod_enabled: row.automod_enabled,
				welcome_enabled: row.welcome_enabled,
				welcome_channel_id: row.welcome_channel_id?.toString() ?? null,
				welcome_message: row.welcome_message,
				welcome_embed: row.welcome_embed,
				goodbye_enabled: row.goodbye_enabled,
				goodbye_channel_id: row.goodbye_channel_id?.toString() ?? null,
				goodbye_message: row.goodbye_message,
				goodbye_embed: row.goodbye_embed,
				autorole_ids: [...(row.autorole_ids ?? [])].map(String),
				level_up_message_enabled: row.level_up_message_enabled,
				level_up_channel_id: row.level_up_channel_id?.toString() ?? null,
				level_up_message: row.level_up_message,
				no_xp_channel_ids: [...(row.no_xp_channel_ids ?? [])].map(String),
				no_xp_role_ids: [...(row.no_xp_role_ids ?? [])].map(String),
				voice_xp_enabled: row.voice_xp_enabled,
				updated_at: stored?.updated_at.toISOString() ?? null,
			},
			default_messages: {
				welcome: MICUPBOT_TEXT.defaultWelcome,
				goodbye: MICUPBOT_TEXT.defaultGoodbye,
				level_up: MICUPBOT_TEXT.defaultLevelUp,
			},
			limits: MICUPBOT_LIMITS,
		};
	}
	async updateSettings({
		guildData,
		userId,
		data,
	}: MicupBotSettingsContext & {data: MicupBotSettingsUpdateRequest}): Promise<MicupBotSettingsResponse> {
		this.requireLive();
		const guildId = createGuildID(BigInt(guildData.id));
		const botId = await this.memberBot(guildId);
		let toggleClaimed = false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const stored = await this.deps.repository.getSettings(guildId);
			const current = stored ?? this.defaultSettings(guildId, userId);
			const row: MicupBotGuildSettingsRow = {
				...current,
				...data,
				welcome_channel_id:
					data.welcome_channel_id === undefined
						? current.welcome_channel_id
						: data.welcome_channel_id === null
							? null
							: createChannelID(data.welcome_channel_id),
				goodbye_channel_id:
					data.goodbye_channel_id === undefined
						? current.goodbye_channel_id
						: data.goodbye_channel_id === null
							? null
							: createChannelID(data.goodbye_channel_id),
				level_up_channel_id:
					data.level_up_channel_id === undefined
						? current.level_up_channel_id
						: data.level_up_channel_id === null
							? null
							: createChannelID(data.level_up_channel_id),
				autorole_ids:
					data.autorole_ids === undefined ? current.autorole_ids : new Set(data.autorole_ids.map(createRoleID)),
				no_xp_channel_ids:
					data.no_xp_channel_ids === undefined
						? current.no_xp_channel_ids
						: new Set(data.no_xp_channel_ids.map(createChannelID)),
				no_xp_role_ids:
					data.no_xp_role_ids === undefined ? current.no_xp_role_ids : new Set(data.no_xp_role_ids.map(createRoleID)),
				updated_by: userId,
				updated_at: new Date(),
			};
			if (data.autorole_ids !== undefined) {
				const {checkPermission} = await this.deps.guildService.getGuildAuthenticated({guildId, userId});
				await checkPermission(Permissions.MANAGE_ROLES);
				await this.validateRoles(guildData, userId, botId, [...(row.autorole_ids ?? [])]);
			}
			for (const [field, relatedFields] of [
				['welcome_channel_id', ['welcome_message', 'welcome_embed', 'welcome_enabled']],
				['goodbye_channel_id', ['goodbye_message', 'goodbye_embed', 'goodbye_enabled']],
				['level_up_channel_id', ['level_up_message', 'level_up_message_enabled']],
			] as const) {
				if (
					row[field] !== null &&
					(data[field] !== undefined || relatedFields.some((related) => data[related] !== undefined))
				)
					await this.validateChannel(
						guildId,
						userId,
						row[field],
						field,
						Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.EMBED_LINKS,
					);
			}
			if (!toggleClaimed)
				toggleClaimed = await this.claimModuleChange(
					guildData,
					row,
					await this.deps.repository.listRules(guildId),
					botId !== null,
				);
			if (!(await this.deps.repository.putSettings(row, stored?.version ?? null))) continue;
			try {
				if (botId !== null) await syncMicupBotGuildFlags({guildId, botPresent: true, deps: this.deps});
				await this.deps.repository.setVoiceGuild(guildId, row.levels_enabled && row.voice_xp_enabled);
			} finally {
				await invalidateMicupBotGuildConfig(guildId);
			}
			return this.getSettings({guildData, userId});
		}
		throw new ResourceLockedError();
	}
	async getAutomod({guildData}: MicupBotSettingsContext): Promise<MicupBotAutomodResponse> {
		const rows = await this.deps.repository.listRules(createGuildID(BigInt(guildData.id)));
		return {
			rules: MICUPBOT_AUTOMOD_RULES.map((rule) => {
				const row = rows.find((entry) => entry.rule === rule);
				return {
					rule,
					enabled: row?.enabled ?? false,
					action: row?.action ?? 'delete_warn',
					threshold:
						row?.threshold ??
						(rule === 'spam' || rule === 'mentions' || rule === 'caps' ? MICUPBOT_THRESHOLDS[rule].def : 0),
					mute_seconds: row?.mute_seconds ?? MICUPBOT_LIMITS.muteDefaultSeconds,
					words: [...(row?.words ?? [])],
					allowed_domains: [...(row?.allowed_domains ?? [])],
					exempt_role_ids: [...(row?.exempt_role_ids ?? [])].map(String),
					exempt_channel_ids: [...(row?.exempt_channel_ids ?? [])].map(String),
				};
			}),
		};
	}
	async updateAutomod({
		guildData,
		userId,
		data,
	}: MicupBotSettingsContext & {data: MicupBotAutomodUpdateRequest}): Promise<MicupBotAutomodResponse> {
		this.requireLive();
		const guildId = createGuildID(BigInt(guildData.id));
		const rows: Array<MicupBotAutomodRuleRow> = data.rules.map((rule) => ({
			...rule,
			guild_id: guildId,
			words: new Set(rule.words),
			allowed_domains: new Set(rule.allowed_domains),
			exempt_role_ids: new Set(rule.exempt_role_ids.map(createRoleID)),
			exempt_channel_ids: new Set(rule.exempt_channel_ids.map(createChannelID)),
			updated_by: userId,
			updated_at: new Date(),
		}));
		const botId = await this.memberBot(guildId);
		await this.claimModuleChange(guildData, await this.deps.repository.getSettings(guildId), rows, botId !== null);
		await this.deps.repository.replaceRules(guildId, rows);
		try {
			if (botId !== null) await syncMicupBotGuildFlags({guildId, botPresent: true, deps: this.deps});
		} finally {
			await invalidateMicupBotGuildConfig(guildId);
		}
		return this.getAutomod({guildData, userId});
	}
	async listPanels({guildData}: MicupBotSettingsContext): Promise<MicupBotReactionRolePanelListResponse> {
		const panels = await this.deps.repository.listPanels(createGuildID(BigInt(guildData.id)));
		return {panels: panels.map((row) => this.panelResponse(row)), max_panels: MICUPBOT_LIMITS.panelsMax};
	}
	async createPanel({
		guildData,
		userId,
		data,
		requestCache,
	}: MicupBotSettingsContext & {
		data: MicupBotReactionRolePanelCreateRequest;
		requestCache: RequestCache;
	}): Promise<MicupBotReactionRolePanelResponse> {
		this.requireLive();
		const guildId = createGuildID(BigInt(guildData.id));
		if ((await this.deps.repository.listPanels(guildId)).length >= MICUPBOT_LIMITS.panelsMax)
			throw new MaxMicupBotReactionRolePanelsError(MICUPBOT_LIMITS.panelsMax);
		const botId = await this.memberBot(guildId);
		if (botId === null) throw new MicupBotNotInGuildError();
		const botUser = await this.deps.userRepository.findUnique(botId);
		if (!botUser) throw new MicupBotNotInGuildError();
		const channelId = createChannelID(data.channel_id);
		await this.validateChannel(
			guildId,
			userId,
			channelId,
			'channel_id',
			Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS,
		);
		const botPermissions = await this.deps.gatewayService.getUserPermissions({guildId, userId: botId, channelId});
		const requiredBotPermissions =
			Permissions.VIEW_CHANNEL |
			Permissions.SEND_MESSAGES |
			Permissions.EMBED_LINKS |
			Permissions.ADD_REACTIONS |
			Permissions.READ_MESSAGE_HISTORY;
		if ((botPermissions & requiredBotPermissions) !== requiredBotPermissions) throw new MissingPermissionsError();
		await this.validateRoles(
			guildData,
			userId,
			botId,
			data.entries.map((entry) => createRoleID(entry.role_id)),
		);
		const entries: MicupBotReactionRolePanelResponse['entries'] = [];
		for (const [index, entry] of data.entries.entries()) {
			let name = entry.emoji.name;
			if (entry.emoji.id == null) {
				if (!isValidSingleUnicodeEmoji(name))
					throw InputValidationError.fromCode(`entries.${index}.emoji`, ValidationErrorCodes.NOT_A_VALID_UNICODE_EMOJI);
			} else {
				const emoji = await this.deps.guildRepository.getEmoji(createEmojiID(entry.emoji.id), guildId);
				if (!emoji)
					throw InputValidationError.fromCode(`entries.${index}.emoji`, ValidationErrorCodes.CUSTOM_EMOJI_NOT_FOUND);
				name = emoji.name;
			}
			entries.push({emoji: {name, id: entry.emoji.id?.toString() ?? null}, role_id: entry.role_id.toString()});
		}
		const lines = entries.map(
			({emoji, role_id}) => `${emoji.id === null ? emoji.name : `<:${emoji.name}:${emoji.id}>`} → <@&${role_id}>`,
		);
		const {message} = await this.deps.channelService.messages.send.sendMessage({
			viewer: {kind: 'user', userId: botId, bot: true, capable: true},
			user: botUser,
			channelId,
			data: {
				embeds: [
					{
						title: data.title,
						description: [data.description, ...lines].filter(Boolean).join('\n'),
						color: MICUPBOT_EMBED_COLOR,
					},
				],
				allowed_mentions: {parse: []},
			},
			requestCache,
		});
		for (const {emoji} of entries) {
			try {
				await this.deps.channelService.interactions.addReaction({
					viewer: {kind: 'user', userId: botId, bot: true, capable: true},
					userId: botId,
					channelId,
					messageId: message.id,
					emoji: emoji.id === null ? emoji.name : `${emoji.name}:${emoji.id}`,
					requestCache,
				});
			} catch (error) {
				Logger.warn(
					{error, guildId: guildId.toString(), messageId: message.id.toString()},
					'Failed to add MicupBOT panel reaction',
				);
			}
		}
		const row: MicupBotReactionRolePanelRow = {
			guild_id: guildId,
			message_id: message.id,
			channel_id: channelId,
			mode: data.mode,
			title: data.title,
			description: data.description ?? null,
			panel_entries: JSON.stringify(entries),
			created_by: userId,
			created_at: new Date(),
		};
		try {
			await withGuildUpdateLock(this.deps.cacheService, guildId, async () => {
				if ((await this.deps.repository.listPanels(guildId)).length >= MICUPBOT_LIMITS.panelsMax) {
					throw new MaxMicupBotReactionRolePanelsError(MICUPBOT_LIMITS.panelsMax);
				}
				await this.deps.repository.putPanel(row);
			});
		} catch (error) {
			try {
				// A timed-out write can already be committed; only remove a confirmed orphan.
				if (!(await this.deps.repository.getPanel(guildId, message.id))) {
					await this.deletePanelMessage(row, botId, requestCache);
				}
			} catch (lookupError) {
				Logger.warn(
					{error: lookupError, guildId: guildId.toString(), messageId: message.id.toString()},
					'Unable to verify MicupBOT panel write; keeping its message',
				);
			}
			throw error;
		}
		return this.panelResponse(row);
	}
	async deletePanel({
		guildData,
		messageId,
		requestCache,
	}: MicupBotSettingsContext & {messageId: MessageID; requestCache: RequestCache}): Promise<void> {
		this.requireLive();
		const guildId = createGuildID(BigInt(guildData.id));
		const panel = await this.deps.repository.getPanel(guildId, messageId);
		if (!panel) throw new UnknownMicupBotReactionRolePanelError();
		await this.deps.repository.deletePanel(guildId, messageId);
		const botId = micupBotUserId();
		if (botId !== null) await this.deletePanelMessage(panel, botId, requestCache);
	}
	async listRewards({guildData}: MicupBotSettingsContext): Promise<MicupBotLevelRewardsResponse> {
		const rewards = await this.deps.repository.listRewards(createGuildID(BigInt(guildData.id)));
		return {
			rewards: rewards.map((row) => ({level: row.level, role_id: row.role_id.toString()})),
			max_rewards: MICUPBOT_LIMITS.rewardsMax,
		};
	}
	async updateRewards({
		guildData,
		userId,
		data,
	}: MicupBotSettingsContext & {data: MicupBotLevelRewardsUpdateRequest}): Promise<MicupBotLevelRewardsResponse> {
		this.requireLive();
		const guildId = createGuildID(BigInt(guildData.id));
		await this.validateRoles(
			guildData,
			userId,
			await this.memberBot(guildId),
			data.rewards.map((row) => createRoleID(row.role_id)),
		);
		await this.deps.repository.replaceRewards(
			guildId,
			data.rewards.map((row) => ({
				guild_id: guildId,
				level: row.level,
				role_id: createRoleID(row.role_id),
				updated_by: userId,
				updated_at: new Date(),
			})),
		);
		return this.listRewards({guildData, userId});
	}
	async getLeaderboard({
		guildId,
		offset,
		limit,
		requestCache,
	}: {
		guildId: GuildID;
		offset: number;
		limit: number;
		requestCache: RequestCache;
	}): Promise<MicupBotLeaderboardResponse> {
		const config = await getMicupBotGuildConfig(guildId);
		if (!config?.settings.levels_enabled) return {levels_enabled: false, total: 0, entries: []};
		if (!(await leaderboardExists(this.deps.kvClient, guildId))) {
			try {
				await this.deps
					.workerService()
					.addJob(
						'rebuildMicupBotLeaderboard',
						{guild_id: guildId.toString()},
						{jobKey: `lbr:${guildId}`, skipLedger: true},
					);
			} catch (error) {
				Logger.warn({error, guildId: guildId.toString()}, 'Failed to queue MicupBOT leaderboard rebuild');
			}
			return {levels_enabled: true, total: 0, entries: []};
		}
		const [top, total] = await Promise.all([
			leaderboardTop(this.deps.kvClient, guildId, offset, limit),
			leaderboardCount(this.deps.kvClient, guildId),
		]);
		const users = await this.deps.userCacheService.getUserPartialResponses(
			top.map((entry) => createUserID(BigInt(entry.userId))),
			requestCache,
		);
		return {
			levels_enabled: true,
			total,
			entries: top.map((entry, index) => ({
				rank: offset + index + 1,
				user_id: entry.userId,
				xp: entry.xp,
				level: levelFromXp(entry.xp).level,
				user: users.get(createUserID(BigInt(entry.userId))) ?? null,
			})),
		};
	}
	async listWarnings({
		guildData,
		targetId,
	}: MicupBotSettingsContext & {targetId: UserID}): Promise<MicupBotWarningListResponse> {
		const warnings = await this.deps.repository.listWarnings(
			createGuildID(BigInt(guildData.id)),
			targetId,
			MICUPBOT_LIMITS.warningsMax,
		);
		return {
			warnings: warnings.map((row) => ({
				id: row.warning_id.toString(),
				moderator_id: row.moderator_id.toString(),
				reason: row.reason,
				created_at: row.created_at.toISOString(),
			})),
		};
	}
	async clearWarnings({guildData, targetId}: MicupBotSettingsContext & {targetId: UserID}): Promise<void> {
		this.requireLive();
		await this.deps.repository.deleteWarnings(createGuildID(BigInt(guildData.id)), targetId);
	}
	async deleteWarning({
		guildData,
		targetId,
		warningId,
	}: MicupBotSettingsContext & {targetId: UserID; warningId: bigint}): Promise<void> {
		this.requireLive();
		if (!(await this.deps.repository.deleteWarning(createGuildID(BigInt(guildData.id)), targetId, warningId)))
			throw new UnknownMicupBotWarningError();
	}

	private requireLive(): void {
		if (!isMicupBotLive(this.deps.limitConfigService)) throw new FeatureTemporarilyDisabledError();
	}

	private async deletePanelMessage(
		panel: MicupBotReactionRolePanelRow,
		botId: UserID,
		requestCache: RequestCache,
	): Promise<void> {
		try {
			await this.deps.channelService.messages.deletion.deleteMessage({
				viewer: {kind: 'user', userId: botId, bot: true, capable: true},
				userId: botId,
				channelId: panel.channel_id,
				messageId: panel.message_id,
				requestCache,
			});
		} catch (error) {
			Logger.warn(
				{error, guildId: panel.guild_id.toString(), messageId: panel.message_id.toString()},
				'Failed to delete MicupBOT panel message',
			);
		}
	}

	private async memberBot(guildId: GuildID): Promise<UserID | null> {
		const botId = micupBotUserId();
		return botId !== null && (await this.deps.guildRepository.getMember(guildId, botId)) !== null ? botId : null;
	}

	private async roleProblems(
		guildData: GuildResponse,
		userId: UserID,
		botId: UserID | null,
		roleIds: Array<RoleID>,
	): Promise<Array<RoleID>> {
		if (roleIds.length === 0) return [];
		const guildId = createGuildID(BigInt(guildData.id));
		const [roles, callerRoles, botRoles] = await Promise.all([
			this.deps.guildRepository.listRoles(guildId),
			guildData.owner_id === userId.toString() ? null : this.deps.gatewayService.getAssignableRoles({guildId, userId}),
			botId === null ? null : this.deps.gatewayService.getAssignableRoles({guildId, userId: botId}),
		]);
		const byId = new Map(roles.map((role) => [role.id, role]));
		const callerAssignable = callerRoles === null ? null : new Set(callerRoles);
		const botAssignable = botRoles === null ? null : new Set(botRoles);
		return roleIds.filter((roleId) => {
			const role = byId.get(roleId);
			return (
				!role ||
				role.guildId !== guildId ||
				micupBotRoleProblem(role, guildId) !== null ||
				(callerAssignable !== null && !callerAssignable.has(roleId)) ||
				(botAssignable !== null && !botAssignable.has(roleId))
			);
		});
	}

	private async validateRoles(
		guildData: GuildResponse,
		userId: UserID,
		botId: UserID | null,
		roleIds: Array<RoleID>,
	): Promise<void> {
		const [problem] = await this.roleProblems(guildData, userId, botId, roleIds);
		if (problem !== undefined) throw new MicupBotRoleNotAssignableError(problem.toString());
	}

	private async validateChannel(
		guildId: GuildID,
		userId: UserID,
		channelId: ChannelID,
		field: string,
		required: bigint,
	): Promise<void> {
		const channel = await this.deps.channelRepository.channelData.findUnique(channelId);
		if (!channel || channel.guildId !== guildId)
			throw InputValidationError.fromCode(field, ValidationErrorCodes.CHANNEL_DOES_NOT_EXIST);
		if (channel.type !== ChannelTypes.GUILD_TEXT)
			throw InputValidationError.fromCode(field, ValidationErrorCodes.INVALID_CHANNEL_ID);
		const permissions = await this.deps.gatewayService.getUserPermissions({guildId, userId, channelId});
		if ((permissions & required) !== required) throw new MissingPermissionsError();
	}

	private async claimModuleChange(
		guildData: GuildResponse,
		settings: MicupBotGuildSettingsRow | null,
		rules: Array<MicupBotAutomodRuleRow>,
		botPresent: boolean,
	): Promise<boolean> {
		const desired = desiredMicupBotFlags({settings, rules, botPresent});
		const flags = [
			GuildFeatures.MICUPBOT_COMMANDS,
			GuildFeatures.MICUPBOT_LEVELS,
			GuildFeatures.MICUPBOT_AUTOMOD,
			GuildFeatures.MICUPBOT_JOIN,
		];
		if (flags.every((flag) => desired.has(flag) === guildData.features.includes(flag))) return false;
		const seconds = MICUPBOT_MODULE_TOGGLE_COOLDOWN_SECONDS;
		if (!(await this.deps.kvClient.setnx(`micupbot:mod:${guildData.id}`, '1', seconds)))
			throw new RateLimitError({retryAfter: seconds, limit: 1, resetTime: new Date(Date.now() + seconds * 1000)});
		return true;
	}

	private panelResponse(row: MicupBotReactionRolePanelRow): MicupBotReactionRolePanelResponse {
		return {
			message_id: row.message_id.toString(),
			channel_id: row.channel_id.toString(),
			mode: row.mode,
			title: row.title,
			description: row.description,
			entries: JSON.parse(row.panel_entries) as MicupBotReactionRolePanelResponse['entries'],
			created_at: row.created_at.toISOString(),
		};
	}

	private defaultSettings(guildId: GuildID, userId: UserID): MicupBotGuildSettingsRow {
		return {
			guild_id: guildId,
			commands_enabled: false,
			levels_enabled: false,
			automod_enabled: false,
			welcome_enabled: false,
			welcome_channel_id: null,
			welcome_message: null,
			welcome_embed: false,
			goodbye_enabled: false,
			goodbye_channel_id: null,
			goodbye_message: null,
			goodbye_embed: false,
			autorole_ids: null,
			level_up_message_enabled: true,
			level_up_channel_id: null,
			level_up_message: null,
			no_xp_channel_ids: null,
			no_xp_role_ids: null,
			voice_xp_enabled: false,
			updated_by: userId,
			updated_at: new Date(),
			version: 0,
		};
	}
}
