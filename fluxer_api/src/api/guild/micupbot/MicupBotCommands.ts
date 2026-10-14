// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createChannelID,
	createGuildID,
	createMessageID,
	createRoleID,
	createUserID,
	guildIdToRoleId,
} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import type {MessageRequest} from '@app/api/channel/MessageTypes';
import {CrosspostSourceService} from '@app/api/channel/services/message/CrosspostSourceService';
import {MessageRequestService} from '@app/api/channel/services/message/MessageRequestService';
import {createMessageResponseDataService} from '@app/api/channel/services/message/MessageResponseDataService';
import type {ThreadViewer} from '@app/api/experiment/ChannelThreadsGate';
import {isMicupBotLive, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {
	commandInput,
	commandUsage,
	MicupBotCommandUsageError,
	parseMicupBotCommand,
} from '@app/api/guild/micupbot/MicupBotCommandParse';
import {
	MICUPBOT_EMBED_COLOR,
	MICUPBOT_HEAVY_COMMANDS,
	MICUPBOT_LIMITS,
	MICUPBOT_RATES,
	MICUPBOT_TEXT,
} from '@app/api/guild/micupbot/MicupBotConstants';
import {leaderboardExists, leaderboardTop} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import {createMicupBotLevels} from '@app/api/guild/micupbot/MicupBotLevels';
import {renderMicupBotTemplate} from '@app/api/guild/micupbot/MicupBotTemplate';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getGuildDiscoveryRepository, getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import {mapUserToPartialResponse} from '@app/api/user/UserMappers';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {ChannelTypes, Permissions} from '@fluxer/constants/src/ChannelConstants';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import {MfaNotEnabledError} from '@fluxer/errors/src/domains/auth/MfaNotEnabledError';
import {UnknownChannelError} from '@fluxer/errors/src/domains/channel/UnknownChannelError';
import {InputValidationError} from '@fluxer/errors/src/domains/core/InputValidationError';
import {MissingAccessError} from '@fluxer/errors/src/domains/core/MissingAccessError';
import {MissingPermissionsError} from '@fluxer/errors/src/domains/core/MissingPermissionsError';
import {UnknownGuildMemberError} from '@fluxer/errors/src/domains/guild/UnknownGuildMemberError';
import {UnknownGuildRoleError} from '@fluxer/errors/src/domains/guild/UnknownGuildRoleError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import {ChannelUpdateRequest} from '@fluxer/schema/src/domains/channel/ChannelRequestSchemas';
import {GuildMemberUpdateRequest} from '@fluxer/schema/src/domains/guild/GuildRequestSchemas';
import {SnowflakeType} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';

export interface MicupBotCommandPayload {
	guild_id: string;
	channel_id: string;
	message_id: string;
	author_id: string;
	content: string;
	at: number;
}
type CommandReply = Pick<MessageRequest, 'content' | 'embeds'>;
const embed = (data: NonNullable<MessageRequest['embeds']>[number]): CommandReply => ({
	embeds: [{...data, color: MICUPBOT_EMBED_COLOR}],
});
const escapeText = (text: string) => renderMicupBotTemplate('{user.name}', {userId: '', userName: text, guildName: ''});

export function createMicupBotCommandRunner(deps: WorkerDependencies) {
	return {
		async run(payload: MicupBotCommandPayload): Promise<void> {
			let reply: ((data: CommandReply) => Promise<void>) | undefined;
			let commandName = payload.content.trim().split(/\s+/, 1)[0].slice(1).toLowerCase();
			try {
				if (!isMicupBotLive(deps.limitConfigService)) return;
				const {kvClient, guildRepository, channelRepository, guildService, channelService} = deps;
				const guildId = createGuildID(BigInt(payload.guild_id));
				const channelId = createChannelID(BigInt(payload.channel_id));
				const messageId = createMessageID(BigInt(payload.message_id));
				const userId = createUserID(BigInt(payload.author_id));
				const botId = micupBotUserId();
				if (!botId) return;
				if (
					!(await kvClient.checkLeakyBucketLimit(`micupbot:cmd:g:${guildId}`, ...MICUPBOT_RATES.commandGuild, 1))
						.allowed
				)
					return;
				if (
					MICUPBOT_HEAVY_COMMANDS.some((name) => name === commandName) &&
					!(await kvClient.checkLeakyBucketLimit(`micupbot:cmd:h:${guildId}`, ...MICUPBOT_RATES.commandHeavy, 1))
						.allowed
				)
					return;
				if (!(await kvClient.setnx(`micupbot:cmd:run:${messageId}`, '1', 86400))) return;
				if (!(await guildRepository.getMember(guildId, botId))) return;
				const message = await channelRepository.messages.getMessage(channelId, messageId);
				if (!message || message.authorId !== userId || message.webhookId || message.content !== payload.content) return;
				const guild = await guildRepository.findUnique(guildId);
				if (!guild?.features.has(GuildFeatures.MICUPBOT_COMMANDS)) return;
				const author = await deps.userRepository.findUnique(userId);
				if (!author || author.isBot) return;
				const viewer: ThreadViewer = {kind: 'user', userId, bot: false, capable: false};
				const sourceChannel = await channelRepository.channelData.findUnique(channelId);
				if (sourceChannel?.guildId !== guildId) return;
				const requestCache = createRequestCache();
				reply = async (data) => {
					try {
						const user = await deps.userRepository.findUnique(botId);
						if (!user) return;
						await channelService.messages.send.sendMessage({
							viewer: {kind: 'user', userId: botId, bot: true, capable: true},
							user,
							channelId,
							requestCache,
							data: {
								...data,
								message_reference: {message_id: messageId, channel_id: channelId, guild_id: guildId},
								allowed_mentions: {parse: [], replied_user: false},
							},
						});
					} catch (error) {
						Logger.warn({error, guildId, messageId}, 'MicupBOT command reply failed');
					}
				};
				const auth = await guildService.getGuildAuthenticated({userId, guildId});
				await channelService.channelData.operations.getChannel({viewer, userId, channelId});
				const command = parseMicupBotCommand(payload.content);
				commandName = command.name;
				const targetId = command.userId ?? userId;
				const auditLogReason = command.reason ?? MICUPBOT_TEXT.audit.command(command.name);
				const targetUser = async () => {
					const user = await deps.userRepository.findUnique(targetId);
					if (!user) throw new UnknownUserError();
					return user;
				};
				const targetName = async () => {
					const user = mapUserToPartialResponse(await targetUser());
					return escapeText(user.global_name ?? user.username);
				};
				const targetMember = () => guildService.members.getMember({userId, targetId, guildId, requestCache});
				const targetChannel = async () => {
					const channel = await channelService.channelData.operations.getChannel({
						viewer,
						userId,
						channelId: command.channelId ?? channelId,
					});
					if (channel.guildId !== guildId) throw new UnknownChannelError();
					return channel;
				};
				const updateMember = (data: unknown) =>
					guildService.members.updateMember(
						{
							userId,
							targetId,
							guildId,
							data: commandInput(GuildMemberUpdateRequest, data, command.name),
							requestCache,
						},
						auditLogReason,
					);
				const execute = async (): Promise<CommandReply> => {
					switch (command.name) {
						case 'ban': {
							const name = await targetName();
							await guildService.moderation.banMember(
								{userId, targetId, guildId, reason: command.reason, banDurationSeconds: command.duration},
								auditLogReason,
							);
							return {content: MICUPBOT_TEXT.banned(name)};
						}
						case 'unban':
							await guildService.moderation.unbanMember({userId, targetId, guildId}, auditLogReason);
							return {content: MICUPBOT_TEXT.unbanned(String(targetId))};
						case 'kick': {
							const name = await targetName();
							await guildService.members.removeMember({userId, targetId, guildId}, auditLogReason);
							return {content: MICUPBOT_TEXT.kicked(name)};
						}
						case 'mute':
						case 'timeout':
							await updateMember({
								communication_disabled_until: new Date(Date.now() + command.duration! * 1000).toISOString(),
								timeout_reason: auditLogReason,
							});
							return {content: MICUPBOT_TEXT.muted(await targetName(), MICUPBOT_TEXT.duration(command.duration!))};
						case 'unmute':
							await updateMember({communication_disabled_until: null});
							return {content: MICUPBOT_TEXT.unmuted(await targetName())};
						case 'clear': {
							const access = await channelService.messages.channelAuth.getChannelAuthenticated({
								viewer,
								userId,
								channelId,
							});
							await access.checkPermission(Permissions.MANAGE_MESSAGES);
							await access.checkPermission(Permissions.READ_MESSAGE_HISTORY);
							const messages = await new MessageRequestService(
								channelService,
								createMessageResponseDataService(),
								new CrosspostSourceService(
									guildRepository,
									getGuildDiscoveryRepository(),
									deps.gatewayService,
									deps.cacheService,
								),
							).listMessages({
								viewer,
								userId,
								channelId,
								requestCache,
								query: {limit: command.count!, before: messageId},
							});
							const messageIds = messages
								.filter((item) => !command.userId || item.author.id === String(command.userId))
								.map((item) => createMessageID(BigInt(item.id)));
							if (messageIds.length)
								await channelService.messages.deletion.bulkDeleteMessages({
									viewer,
									userId,
									channelId,
									messageIds,
									auditLogReason,
								});
							return {content: MICUPBOT_TEXT.cleared(messageIds.length)};
						}
						case 'lock':
						case 'unlock': {
							const channel = await targetChannel();
							const existing = channel.permissionOverwrites.get(guildIdToRoleId(guildId));
							const allow = existing?.allow ?? 0n;
							const deny = existing?.deny ?? 0n;
							await channelService.channelData.operations.setChannelPermissionOverwrite({
								viewer,
								userId,
								channelId: channel.id,
								overwriteId: guildId,
								overwrite: {
									type: 0,
									allow_: command.name === 'lock' ? allow & ~Permissions.SEND_MESSAGES : allow,
									deny_: command.name === 'lock' ? deny | Permissions.SEND_MESSAGES : deny & ~Permissions.SEND_MESSAGES,
								},
								clientFeatures: new Set(),
								requestCache,
								auditLogReason,
							});
							return {content: command.name === 'lock' ? MICUPBOT_TEXT.locked : MICUPBOT_TEXT.unlocked};
						}
						case 'slowmode': {
							const channel = await targetChannel();
							await channelService.channelData.editChannel({
								viewer,
								userId,
								channelId: channel.id,
								data: commandInput(
									ChannelUpdateRequest,
									{type: channel.type, rate_limit_per_user: command.seconds},
									command.name,
								),
								clientFeatures: new Set(),
								requestCache,
								auditLogReason,
							});
							return {content: command.seconds ? MICUPBOT_TEXT.slowmodeOn(command.seconds) : MICUPBOT_TEXT.slowmodeOff};
						}
						case 'role': {
							const raw = command.role!;
							const id = SnowflakeType.safeParse(raw.match(/^<@&(\d+)>$/)?.[1] ?? raw);
							const role = id.success
								? await guildRepository.getRole(createRoleID(id.data), guildId)
								: (await guildRepository.listRoles(guildId)).find(
										(role) => role.name.toLocaleLowerCase('tr-TR') === raw.toLocaleLowerCase('tr-TR'),
									);
							if (!role) throw new UnknownGuildRoleError();
							const member = await targetMember();
							const remove = member.roles.includes(String(role.id));
							const params = {userId, targetId, guildId, roleId: role.id, requestCache};
							if (remove) await guildService.members.removeMemberRole(params, auditLogReason);
							else await guildService.members.addMemberRole(params, auditLogReason);
							return {
								content: (remove ? MICUPBOT_TEXT.roleRemoved : MICUPBOT_TEXT.roleAdded)(
									escapeText(role.name),
									await targetName(),
								),
							};
						}
						case 'nick':
							await updateMember({nick: command.nick});
							return {
								content: (command.nick ? MICUPBOT_TEXT.nickChanged : MICUPBOT_TEXT.nickReset)(await targetName()),
							};
						case 'move': {
							const channel = await targetChannel();
							if (channel.type !== ChannelTypes.GUILD_VOICE) throw new MicupBotCommandUsageError(command.name);
							await updateMember({channel_id: String(channel.id)});
							return {content: MICUPBOT_TEXT.moved(await targetName(), String(channel.id))};
						}
						case 'rank':
						case 'top': {
							if (!guild.features.has(GuildFeatures.MICUPBOT_LEVELS)) return {content: MICUPBOT_TEXT.levelsOff};
							if (!(await leaderboardExists(kvClient, guildId))) {
								await deps.workerService.addJob(
									'rebuildMicupBotLeaderboard',
									{guild_id: String(guildId)},
									{jobKey: `lbr:${guildId}`},
								);
								return {content: MICUPBOT_TEXT.topEmpty};
							}
							if (command.name === 'rank') {
								await targetMember();
								const {level, current, next, rank} = await createMicupBotLevels(deps).getMemberStats(guildId, targetId);
								return {content: MICUPBOT_TEXT.rank(await targetName(), level, current, next, rank)};
							}
							const rows = await leaderboardTop(kvClient, guildId, 0, 10);
							return embed({
								title: MICUPBOT_TEXT.topTitle,
								description:
									rows.map((row, index) => `${index + 1}. <@${row.userId}> — ${row.xp}`).join('\n') ||
									MICUPBOT_TEXT.topEmpty,
							});
						}
						case 'help':
							return embed({title: MICUPBOT_TEXT.helpTitle, description: MICUPBOT_TEXT.helpLines.join('\n')});
						case 'user': {
							const member = await targetMember();
							return embed({
								title: await targetName(),
								fields: [
									{name: MICUPBOT_TEXT.userFields[0], value: snowflakeToDate(targetId).toISOString(), inline: false},
									{name: MICUPBOT_TEXT.userFields[1], value: member.joined_at, inline: false},
									{
										name: MICUPBOT_TEXT.userFields[2],
										inline: false,
										value:
											member.roles
												.map((role) => `<@&${role}>`)
												.join(' ')
												.slice(0, 1024) || '—',
									},
								],
							});
						}
						case 'server': {
							const channels = await deps.gatewayService.getViewableChannels({guildId, userId});
							return embed({
								title: escapeText(guild.name),
								fields: [
									{name: MICUPBOT_TEXT.serverFields[0], value: `<@${guild.ownerId}>`, inline: false},
									{name: MICUPBOT_TEXT.serverFields[1], value: String(guild.memberCount), inline: false},
									{name: MICUPBOT_TEXT.serverFields[2], value: snowflakeToDate(guildId).toISOString(), inline: false},
									{name: MICUPBOT_TEXT.serverFields[3], value: String(channels.length), inline: false},
								],
							});
						}
						case 'avatar': {
							await targetMember();
							const user = mapUserToPartialResponse(await targetUser());
							const url = user.avatar
								? `${Config.endpoints.media}/avatars/${user.id}/${user.avatar.replace(/^a_/, '')}.webp?size=256`
								: `${Config.endpoints.staticCdn}/avatars/${targetId % 6n}.png`;
							return embed({title: await targetName(), image: {url}});
						}
						case 'warn':
						case 'warnings': {
							await auth.checkPermission(Permissions.MODERATE_MEMBERS);
							await targetMember();
							await auth.checkTargetMember(targetId);
							const repository = getMicupBotRepository();
							const name = await targetName();
							if (command.name === 'warn') {
								const key = `micupbot:wlock:${guildId}:${targetId}`,
									token = String(messageId);
								if (!(await kvClient.acquireLock(key, token, 30))) return {content: MICUPBOT_TEXT.failed};
								try {
									const count = await repository.countWarnings(guildId, targetId);
									if (count >= MICUPBOT_LIMITS.warningsMax) return {content: MICUPBOT_TEXT.warningsFull};
									if (!(await kvClient.extendLock(key, token, 30))) return {content: MICUPBOT_TEXT.failed};
									// TEMPORARY: a pause over 30 s after renewal can lose the lease; observed lease loss
									// requires a fenced Cassandra warning write in the repository before raising throughput.
									await repository.addWarning({
										guild_id: guildId,
										user_id: targetId,
										warning_id: messageId,
										moderator_id: userId,
										reason: command.reason!,
										created_at: new Date(),
									});
									return {content: MICUPBOT_TEXT.warned(name, count + 1)};
								} finally {
									await kvClient.releaseLock(key, token);
								}
							}
							const count = await repository.countWarnings(guildId, targetId);
							const warnings = await repository.listWarnings(guildId, targetId, 10);
							if (!warnings.length) return {content: MICUPBOT_TEXT.noWarnings(name)};
							return embed({
								title: MICUPBOT_TEXT.warningsTitle(name),
								footer: {text: String(count)},
								description: warnings
									.map((warning) => `${warning.created_at.toISOString()} · ${escapeText(warning.reason)}`)
									.join('\n')
									.slice(0, 4096),
							});
						}
					}
				};
				await reply(await execute());
			} catch (error) {
				let content: string;
				if (error instanceof MicupBotCommandUsageError) content = error.message;
				else if (error instanceof MissingPermissionsError || error instanceof MissingAccessError)
					content = MICUPBOT_TEXT.noPermission;
				else if (error instanceof MfaNotEnabledError) content = MICUPBOT_TEXT.mfaRequired;
				else if (error instanceof UnknownGuildMemberError || error instanceof UnknownUserError)
					content = MICUPBOT_TEXT.userNotFound;
				else if (error instanceof UnknownGuildRoleError) content = MICUPBOT_TEXT.roleNotFound;
				else if (error instanceof UnknownChannelError) content = MICUPBOT_TEXT.channelNotFound;
				else if (error instanceof InputValidationError)
					content = `${MICUPBOT_TEXT.failed}\n${commandUsage(commandName)}`;
				else {
					content = MICUPBOT_TEXT.failed;
					Logger.warn({error, messageId: payload.message_id}, 'MicupBOT command failed');
				}
				await reply?.({content});
			}
		},
	};
}
