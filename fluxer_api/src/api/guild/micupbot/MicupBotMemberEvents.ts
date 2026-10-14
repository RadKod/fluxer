// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {isMicupBotLive, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {MICUPBOT_EMBED_COLOR, MICUPBOT_RATES, MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {syncMicupBotGuildFlags} from '@app/api/guild/micupbot/MicupBotGuildFlags';
import {grantMicupBotRole} from '@app/api/guild/micupbot/MicupBotRoleGrant';
import {getMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {renderMicupBotTemplate} from '@app/api/guild/micupbot/MicupBotTemplate';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
export interface MicupBotMemberEventPayload {
	kind: 'join' | 'leave' | 'bot_join' | 'bot_leave';
	guild_id: string;
	user_id: string;
	temporary?: boolean;
	at: number;
}
export function createMicupBotMemberEventRunner(deps: WorkerDependencies) {
	return {
		async run(payload: MicupBotMemberEventPayload): Promise<void> {
			const botId = micupBotUserId();
			if (botId === null) return;
			const guildId = createGuildID(BigInt(payload.guild_id));
			const userId = createUserID(BigInt(payload.user_id));
			if (payload.kind === 'bot_join' || payload.kind === 'bot_leave') {
				if (userId !== botId) return;
				const repository = getMicupBotRepository();
				const botPresent = payload.kind === 'bot_join';
				await syncMicupBotGuildFlags({guildId, botPresent, deps: {...deps, repository}});
				const config = botPresent ? await getMicupBotGuildConfig(guildId) : null;
				await repository.setVoiceGuild(
					guildId,
					!!(config?.settings.levels_enabled && config.settings.voice_xp_enabled),
				);
				return;
			}
			if (!isMicupBotLive(deps.limitConfigService)) return;
			if (payload.temporary || userId === botId) return;
			const config = await getMicupBotGuildConfig(guildId);
			if (!config) return;
			const {settings} = config;
			const joining = payload.kind === 'join';
			if (joining) {
				const member = await deps.guildRepository.getMember(guildId, userId);
				if (!member || member.isTemporary) return;
			}
			const [user, guild] = await Promise.all([
				deps.userRepository.findUnique(userId),
				deps.guildRepository.findUnique(guildId),
			]);
			if (!user || user.isBot || !guild) return;
			const requestCache = createRequestCache();
			if (joining) {
				let granted = 0,
					skipped = 0,
					failed = 0;
				for (const roleId of settings.autorole_ids ?? []) {
					try {
						const result = await grantMicupBotRole({
							guildId,
							targetId: userId,
							roleId,
							requestCache,
							auditLogReason: MICUPBOT_TEXT.audit.autorole,
							deps,
						});
						if (result === 'skipped') skipped++;
						else granted++;
					} catch (error) {
						failed++;
						Logger.warn({error, guildId: payload.guild_id, roleId: String(roleId)}, 'MicupBOT auto role failed');
					}
				}
				Logger.debug({guildId: payload.guild_id, granted, skipped, failed}, 'MicupBOT auto roles');
			}
			const enabled = joining ? settings.welcome_enabled : settings.goodbye_enabled;
			const channelId = joining ? settings.welcome_channel_id : settings.goodbye_channel_id;
			if (!enabled || channelId === null) return;
			if (joining) {
				// TEMPORARY: frequent >10 joins/s: replace dropped welcomes with a batch every 5 s.
				const [limit, windowMs] = MICUPBOT_RATES.welcome;
				if (!(await deps.kvClient.checkLeakyBucketLimit(`micupbot:welcome:${guildId}`, limit, windowMs, 1)).allowed) {
					Logger.debug({guildId: payload.guild_id, welcome_skipped: 1}, 'MicupBOT welcome rate limited');
					return;
				}
			}
			const text = renderMicupBotTemplate(
				joining
					? (settings.welcome_message ?? MICUPBOT_TEXT.defaultWelcome)
					: (settings.goodbye_message ?? MICUPBOT_TEXT.defaultGoodbye),
				{userId, userName: user.globalName ?? user.username, guildName: guild.name, memberCount: guild.memberCount},
			);
			const embed = joining ? settings.welcome_embed : settings.goodbye_embed;
			const avatar = user.avatarHash
				? `${Config.endpoints.media}/avatars/${userId}/${user.avatarHash}.${user.avatarHash.startsWith('a_') ? 'gif' : 'png'}`
				: `${Config.endpoints.staticCdn}/avatars/${userId % 6n}.png`;
			try {
				const bot = await deps.userRepository.findUnique(botId);
				if (!bot) return;
				await deps.channelService.messages.send.sendMessage({
					viewer: {kind: 'user', userId: botId, bot: true, capable: true},
					user: bot,
					channelId,
					requestCache,
					data: {
						...(embed
							? {embeds: [{description: text, color: MICUPBOT_EMBED_COLOR, thumbnail: {url: avatar}}]}
							: {content: text}),
						allowed_mentions: joining ? {parse: [], users: [userId]} : {parse: []},
					},
				});
			} catch (error) {
				Logger.warn({error, guildId: payload.guild_id, kind: payload.kind}, 'MicupBOT member message failed');
			}
		},
	};
}
