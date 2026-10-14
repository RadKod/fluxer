// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createRoleID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {feedInviteBases} from '@app/api/feed/FeedLinkPreview';
import {detectMicupBotViolation} from '@app/api/guild/micupbot/MicupBotAutomod';
import {isMicupBotLive} from '@app/api/guild/micupbot/MicupBotBot';
import {
	MICUPBOT_COMMAND_NAMES,
	MICUPBOT_HOOK_INFLIGHT_MAX,
	MICUPBOT_PREFIX,
	MICUPBOT_RATES,
	MICUPBOT_SPAM_WINDOW_MS,
} from '@app/api/guild/micupbot/MicupBotConstants';
import {getMicupBotGuildConfig, type MicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {rollMessageXp} from '@app/api/guild/micupbot/MicupBotXp';
import {Logger} from '@app/api/Logger';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getLimitConfigService, getMicupBotLevels} from '@app/api/middleware/ServiceSingletons';
import type {Channel} from '@app/api/models/Channel';
import type {Message} from '@app/api/models/Message';
import type {User} from '@app/api/models/User';
import {MessageTypes} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures, GuildMFALevel} from '@fluxer/constants/src/GuildConstants';
import type {GuildMemberResponse} from '@fluxer/schema/src/domains/guild/GuildMemberSchemas';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';

const commandNames = new Set<string>(MICUPBOT_COMMAND_NAMES);
// TEMPORARY: reserve 200 of the 1,000 flights for commands/moderation; sustained drops -> separate live lane processes.
const XP_INFLIGHT_MAX = 800;
// Snapshot identity changes on cache refresh, including automod-only settings updates.
const automodHosts = new WeakMap<MicupBotGuildConfig, {inviteHosts: Array<string>; ownHosts: Array<string>}>();
let inFlight = 0;
let dropped = 0;
let lastDropWarning = -Infinity;

function drop(): void {
	dropped++;
	const now = Date.now();
	if (now - lastDropWarning >= 60_000) {
		Logger.warn({dropped}, 'MicupBOT hook tasks dropped');
		dropped = 0;
		lastDropWarning = now;
	}
}

function isCommand(content: string): boolean {
	if (!content.startsWith(MICUPBOT_PREFIX)) return false;
	let end = 1;
	while (end < content.length && content[end]!.trim() !== '') end++;
	return commandNames.has(content.slice(1, end).toLowerCase());
}

export function notifyMicupBotMessage(p: {
	guild: GuildResponse | null;
	member: GuildMemberResponse | null;
	channel: Channel;
	message: Message;
	user: User;
	isEdit?: boolean;
}): void {
	try {
		const {guild, member, channel, message, user} = p;
		if (!guild) return;
		const commands = !p.isEdit && guild.features.includes(GuildFeatures.MICUPBOT_COMMANDS);
		const levels = !p.isEdit && guild.features.includes(GuildFeatures.MICUPBOT_LEVELS);
		const automod = guild.features.includes(GuildFeatures.MICUPBOT_AUTOMOD);
		if (!commands && !levels && !automod) return;
		if (!isMicupBotLive(getLimitConfigService()) || user.isBot) return;
		if (message.type !== MessageTypes.DEFAULT && message.type !== MessageTypes.REPLY) return;
		if (message.webhookId) return;
		if (inFlight >= MICUPBOT_HOOK_INFLIGHT_MAX) {
			drop();
			return;
		}
		const content = message.content ?? '';
		const command = commands && isCommand(content);
		const checkAutomod = automod && guild.mfa_level !== GuildMFALevel.ELEVATED;
		const allowXp = inFlight < XP_INFLIGHT_MAX;
		if (!command && !checkAutomod && (!levels || !allowXp)) {
			if (levels && !allowXp) drop();
			return;
		}
		inFlight++;
		void (async () => {
			try {
				const guildId = createGuildID(BigInt(guild.id));
				const payload = {
					guild_id: guild.id,
					channel_id: channel.id.toString(),
					message_id: message.id.toString(),
					author_id: user.id.toString(),
					at: Date.now(),
				};
				const config = checkAutomod || !command ? await getMicupBotGuildConfig(guildId) : null;
				const roles = (member?.roles ?? []).map((id) => createRoleID(BigInt(id)));
				if (checkAutomod && config?.settings.automod_enabled) {
					const rules = config.rules.filter(
						(rule) =>
							rule.enabled &&
							!rule.exempt_channel_ids?.has(channel.id) &&
							!roles.some((id) => rule.exempt_role_ids?.has(id)),
					);
					let hosts = automodHosts.get(config);
					if (!hosts) {
						hosts = {
							inviteHosts: feedInviteBases().map((base) => base.origin + base.pathPrefix),
							ownHosts: Object.values(Config.endpoints)
								.flat()
								.map((endpoint) => new URL(endpoint).hostname),
						};
						automodHosts.set(config, hosts);
					}
					let violation = detectMicupBotViolation({
						content,
						mentionedUserIds: [...message.mentionedUserIds].map(String),
						mentionedRoleIds: [...message.mentionedRoleIds].map(String),
						mentionEveryone: message.mentionEveryone,
						rules,
						...hosts,
					});
					const spam = rules.find((rule) => rule.rule === 'spam');
					if (
						!violation &&
						spam &&
						!(
							await getKVClient().checkLeakyBucketLimit(
								`micupbot:spam:${guildId}:${user.id}`,
								spam.threshold,
								MICUPBOT_SPAM_WINDOW_MS,
								1,
							)
						).allowed
					) {
						violation = {rule: spam.rule, action: spam.action, mute_seconds: spam.mute_seconds};
					}
					if (violation) {
						await getWorkerService().addJob(
							'applyMicupBotAutomodAction',
							{...payload, ...violation},
							{jobKey: `am:${message.id}`, skipLedger: true},
						);
						return;
					}
				}
				if (command) {
					const [limit, windowMs] = MICUPBOT_RATES.commandUser;
					if (
						!(await getKVClient().checkLeakyBucketLimit(`micupbot:cmd:u:${guildId}:${user.id}`, limit, windowMs, 1))
							.allowed
					)
						return;
					await getWorkerService().addJob(
						'runMicupBotCommand',
						{...payload, content: content.slice(0, 2000)},
						{jobKey: message.id.toString(), skipLedger: true},
					);
					return;
				}
				if (!levels || !config?.settings.levels_enabled) return;
				if (
					config.settings.no_xp_channel_ids?.has(channel.id) ||
					roles.some((id) => config.settings.no_xp_role_ids?.has(id))
				)
					return;
				if (!allowXp) {
					drop();
					return;
				}
				await getMicupBotLevels().award({
					guildId,
					userId: user.id,
					channelId: channel.id,
					xp: rollMessageXp(Math.random),
					source: 'message',
				});
			} finally {
				inFlight--;
			}
		})().catch((error: unknown) => Logger.warn({error}, 'MicupBOT message hook failed'));
	} catch (error) {
		Logger.warn({error}, 'MicupBOT message hook failed');
	}
}
