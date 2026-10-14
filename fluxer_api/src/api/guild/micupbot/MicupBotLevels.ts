// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	type ChannelID,
	createChannelID,
	createGuildID,
	createUserID,
	type GuildID,
	type UserID,
} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {
	MICUPBOT_LEVEL_BUCKETS,
	MICUPBOT_XP_COUNTER,
	MICUPBOT_XP_DIRTY_SET,
	micupBotXpCounterId,
} from '@app/api/database/types/MicupBotTypes';
import {isMicupBotLive, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {
	MICUPBOT_TEXT,
	MICUPBOT_XP_COOLDOWN_SECONDS,
	MICUPBOT_XP_FLUSH_BUDGET_MS,
	MICUPBOT_XP_FLUSH_SLICES,
} from '@app/api/guild/micupbot/MicupBotConstants';
import {
	leaderboardAdd,
	leaderboardExists,
	leaderboardRank,
	leaderboardReplace,
	MICUPBOT_LEADERBOARD_SIZE,
} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import type {MicupBotRepository} from '@app/api/guild/micupbot/MicupBotRepository';
import {grantMicupBotRole} from '@app/api/guild/micupbot/MicupBotRoleGrant';
import {getMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {renderMicupBotTemplate} from '@app/api/guild/micupbot/MicupBotTemplate';
import {levelFromXp} from '@app/api/guild/micupbot/MicupBotXp';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {flushCounterSetSlice} from '@app/api/infrastructure/KVCounterSliceFlush';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getKVCounterService, getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
export interface MicupBotLevelUpPayload {
	guild_id: string;
	user_id: string;
	channel_id: string | null;
	level: number;
	at: number;
}
export interface MicupBotXpSlicePayload {
	slice: number;
	minute: number;
}
export interface MicupBotLeaderboardPayload {
	guild_id: string;
}
export interface MicupBotAwardParams {
	guildId: GuildID;
	userId: UserID;
	channelId: ChannelID | null;
	xp: number;
	source: 'message' | 'voice';
}
export interface MicupBotAwardResult {
	xp: number;
	level: number;
	leveledUp: boolean;
}
export interface MicupBotMemberStats {
	xp: number;
	level: number;
	current: number;
	next: number;
	rank: number | null;
}
export type MicupBotLevelsDependencies =
	| WorkerDependencies
	| {
			kvClient: WorkerDependencies['kvClient'];
			counterService: KVCounterService;
			repository: MicupBotRepository;
			workerService: () => WorkerDependencies['workerService'];
	  };
export function createMicupBotLevels(deps: MicupBotLevelsDependencies) {
	const {kvClient} = deps;
	const repository = 'repository' in deps ? deps.repository : getMicupBotRepository();
	const counters = 'counterService' in deps ? deps.counterService : getKVCounterService();
	return {
		async award({
			guildId,
			userId,
			channelId,
			xp: delta,
			source,
		}: MicupBotAwardParams): Promise<MicupBotAwardResult | null> {
			if (
				source === 'message' &&
				!(await kvClient.setnx(`micupbot:xpcd:${guildId}:${userId}`, '1', MICUPBOT_XP_COOLDOWN_SECONDS))
			)
				return null;
			const xp = await counters.add(MICUPBOT_XP_COUNTER, micupBotXpCounterId(guildId, userId), delta);
			if (xp === delta) {
				try {
					await repository.addUserGuild(userId, guildId);
				} catch (error) {
					Logger.warn(
						{error, guildId: String(guildId), userId: String(userId)},
						'Failed to index first MicupBOT XP award',
					);
				}
			}
			if (await leaderboardExists(kvClient, guildId)) {
				await leaderboardAdd(kvClient, guildId, userId, xp);
			} else {
				try {
					const worker = typeof deps.workerService === 'function' ? deps.workerService() : deps.workerService;
					await worker.addJob(
						'rebuildMicupBotLeaderboard',
						{guild_id: String(guildId)},
						{jobKey: `lbr:${guildId}`, skipLedger: true},
					);
				} catch (error) {
					Logger.warn({error, guildId: String(guildId)}, 'Failed to queue MicupBOT leaderboard rebuild');
				}
			}
			const {level} = levelFromXp(xp);
			const leveledUp = levelFromXp(xp - delta).level < level;
			if (leveledUp) {
				try {
					const worker = typeof deps.workerService === 'function' ? deps.workerService() : deps.workerService;
					await worker.addJob(
						'handleMicupBotLevelUp',
						{
							guild_id: String(guildId),
							user_id: String(userId),
							channel_id: channelId === null ? null : String(channelId),
							level,
							at: Date.now(),
						},
						{jobKey: `lv:${guildId}:${userId}:${level}`, skipLedger: true},
					);
				} catch (error) {
					Logger.warn(
						{error, guildId: String(guildId), userId: String(userId), level},
						'Failed to queue MicupBOT level-up',
					);
				}
			}
			return {xp, level, leveledUp};
		},
		async handleLevelUp(payload: MicupBotLevelUpPayload): Promise<void> {
			if (!('guildService' in deps)) throw new Error('MicupBOT level-up requires worker dependencies');
			if (!isMicupBotLive(deps.limitConfigService)) return;
			const guildId = createGuildID(BigInt(payload.guild_id)),
				userId = createUserID(BigInt(payload.user_id));
			const config = await getMicupBotGuildConfig(guildId);
			if (!config?.settings.levels_enabled) return;
			const botId = micupBotUserId();
			if (botId === null) return;
			const member = await deps.guildRepository.getMember(guildId, userId);
			if (!member || !(await deps.guildRepository.getMember(guildId, botId))) return;
			const requestCache = createRequestCache();
			const roles = new Set(member.roleIds);
			let granted = 0,
				skipped = 0,
				failed = 0;
			for (const reward of await repository.listRewards(guildId)) {
				if (reward.level > payload.level || roles.has(reward.role_id)) continue;
				if (member.isTemporary) {
					skipped++;
					continue;
				}
				try {
					const result = await grantMicupBotRole({
						guildId,
						targetId: userId,
						roleId: reward.role_id,
						requestCache,
						auditLogReason: MICUPBOT_TEXT.audit.levelReward,
						deps,
					});
					if (result === 'skipped') skipped++;
					else {
						granted++;
						roles.add(reward.role_id);
					}
				} catch (error) {
					failed++;
					Logger.warn(
						{error, guildId: payload.guild_id, roleId: String(reward.role_id)},
						'MicupBOT level reward failed',
					);
				}
			}
			Logger.info(
				{guildId: payload.guild_id, level: payload.level, granted, skipped, failed},
				'MicupBOT level rewards',
			);
			const {settings} = config;
			const channelId =
				settings.level_up_channel_id ??
				(payload.channel_id === null ? null : createChannelID(BigInt(payload.channel_id)));
			if (!settings.level_up_message_enabled || channelId === null) return;
			try {
				const [bot, user, guild] = await Promise.all([
					deps.userRepository.findUnique(botId),
					deps.userRepository.findUnique(userId),
					deps.guildRepository.findUnique(guildId),
				]);
				if (!bot || !user || !guild) return;
				await deps.channelService.messages.send.sendMessage({
					viewer: {kind: 'user', userId: botId, bot: true, capable: true},
					user: bot,
					channelId,
					requestCache,
					data: {
						content: renderMicupBotTemplate(settings.level_up_message ?? MICUPBOT_TEXT.defaultLevelUp, {
							userId,
							userName: user.globalName ?? user.username,
							guildName: guild.name,
							memberCount: guild.memberCount,
							level: payload.level,
						}),
						allowed_mentions: {parse: [], users: [userId]},
					},
				});
			} catch (error) {
				Logger.warn({error, guildId: payload.guild_id}, 'MicupBOT level-up message failed');
			}
		},
		async flushSlice({slice, minute}: MicupBotXpSlicePayload): Promise<void> {
			// TEMPORARY: at whole-budget warnings or write p99 >50 ms, move the micupbot lane to its own process and a 5 min flush.
			await flushCounterSetSlice({
				counters,
				dirtySet: MICUPBOT_XP_DIRTY_SET,
				slice,
				minute,
				slices: MICUPBOT_XP_FLUSH_SLICES,
				budgetMs: MICUPBOT_XP_FLUSH_BUDGET_MS,
				concurrency: Config.worker.feedViewFlushPartitionConcurrency,
				label: {name: 'MicupBOT XP', backlog: 'XP counts'},
				logger: Logger,
			});
		},
		async rebuildLeaderboard({guild_id}: MicupBotLeaderboardPayload): Promise<void> {
			if (!(await kvClient.setnx(`micupbot:lbr:${guild_id}`, '1', 300))) return;
			const guildId = createGuildID(BigInt(guild_id));
			const top: Array<{userId: string; xp: number}> = [];
			for (let bucket = 0; bucket < MICUPBOT_LEVEL_BUCKETS; bucket++) {
				let after: UserID | null = null;
				for (;;) {
					const page = await repository.listMemberLevelsPage(guildId, bucket, after, 1000);
					for (const row of page) {
						const entry = {userId: String(row.userId), xp: Number(row.xp)};
						let low = 0,
							high = top.length;
						while (low < high) {
							const mid = (low + high) >>> 1;
							const other = top[mid]!;
							if (other.xp > entry.xp || (other.xp === entry.xp && other.userId > entry.userId)) low = mid + 1;
							else high = mid;
						}
						if (low === MICUPBOT_LEADERBOARD_SIZE) continue;
						if (top.length === MICUPBOT_LEADERBOARD_SIZE) top.pop();
						top.splice(low, 0, entry);
					}
					if (page.length < 1000) break;
					after = page[page.length - 1]!.userId;
				}
			}
			// TEMPORARY: unflushed KV XP is repaired by subsequent awards; a separate live snapshot is unnecessary here.
			await leaderboardReplace(kvClient, guildId, top);
		},
		async getMemberStats(guildId: GuildID, userId: UserID): Promise<MicupBotMemberStats> {
			const xp = await counters.get(MICUPBOT_XP_COUNTER, micupBotXpCounterId(guildId, userId));
			return {xp, ...levelFromXp(xp), rank: await leaderboardRank(kvClient, guildId, userId)};
		},
	};
}
