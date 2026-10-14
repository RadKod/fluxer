// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createChannelID,
	createEmojiID,
	createGuildID,
	createMessageID,
	createRoleID,
	createUserID,
} from '@app/api/BrandedTypes';
import {isMicupBotLive, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {MICUPBOT_RATES, MICUPBOT_TEXT} from '@app/api/guild/micupbot/MicupBotConstants';
import {grantMicupBotRole, revokeMicupBotRole} from '@app/api/guild/micupbot/MicupBotRoleGrant';
import {Logger} from '@app/api/Logger';
import {createRequestCache} from '@app/api/middleware/RequestCacheMiddleware';
import {getKVCounterService, getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import type {WorkerDependencies} from '@app/api/worker/WorkerDependencies';
import {MicupBotReactionRolePanelCreateRequest} from '@fluxer/schema/src/domains/micupbot/MicupBotRequestSchemas';
export interface MicupBotReactionRolePayload {
	kind: 'add' | 'remove';
	guild_id: string;
	channel_id: string;
	message_id: string;
	user_id: string;
	emoji_name: string;
	emoji_id: string | null;
	at: number;
}
export function createMicupBotReactionRoleRunner(deps: WorkerDependencies) {
	return {
		async run(payload: MicupBotReactionRolePayload): Promise<void> {
			if (!isMicupBotLive(deps.limitConfigService)) return;
			const guildId = createGuildID(BigInt(payload.guild_id));
			const channelId = createChannelID(BigInt(payload.channel_id));
			const messageId = createMessageID(BigInt(payload.message_id));
			const userId = createUserID(BigInt(payload.user_id));
			if (userId === micupBotUserId()) return;
			const panel = await getMicupBotRepository().getPanel(guildId, messageId);
			if (!panel || panel.channel_id !== channelId) return;
			const entries = MicupBotReactionRolePanelCreateRequest.shape.entries.parse(JSON.parse(panel.panel_entries));
			const entry = entries.find(
				(item) => item.emoji.name === payload.emoji_name && (item.emoji.id?.toString() ?? null) === payload.emoji_id,
			);
			if (!entry) return;
			const [limit, windowMs] = MICUPBOT_RATES.reactionRole;
			if (
				!(await deps.kvClient.checkLeakyBucketLimit(`micupbot:rr:${guildId}:${userId}`, limit, windowMs, 1)).allowed
			) {
				Logger.debug({guildId: payload.guild_id, skipped: 1}, 'MicupBOT reaction role rate limited');
				return;
			}
			const apply = async () => {
				const exists = await deps.channelRepository.messageInteractions.checkUserReactionExists(
					channelId,
					messageId,
					userId,
					payload.emoji_name,
					payload.emoji_id === null ? undefined : createEmojiID(BigInt(payload.emoji_id)),
				);
				if (payload.kind === 'add' ? !exists : exists || panel.mode === 'add_only') return;
				const member = await deps.guildRepository.getMember(guildId, userId);
				if (!member || member.isTemporary) return;
				const params = {
					guildId,
					targetId: userId,
					roleId: createRoleID(entry.role_id),
					requestCache: createRequestCache(),
					auditLogReason: MICUPBOT_TEXT.audit.reactionRole,
					deps,
				};
				const result = await (payload.kind === 'add' ? grantMicupBotRole(params) : revokeMicupBotRole(params));
				let applied = result === 'applied' ? 1 : 0;
				let skipped = result === 'skipped' ? 1 : 0;
				// Keep existing choices when the newly selected role fails role validation, hierarchy or MFA validation.
				if (result === 'applied' && payload.kind === 'add' && panel.mode === 'unique') {
					for (const other of entries) {
						const roleId = createRoleID(other.role_id);
						if (roleId === params.roleId || !member.roleIds.has(roleId)) continue;
						if ((await revokeMicupBotRole({...params, roleId})) === 'skipped') skipped++;
						else applied++;
					}
				}
				Logger.debug({guildId: payload.guild_id, applied, skipped}, 'MicupBOT reaction roles');
			};
			if (panel.mode === 'unique') {
				// Panels can share roles: serialize each member's selections and read their roles inside the lock.
				await getKVCounterService().withSubjectLock('micupbot_reaction_roles', String(guildId), String(userId), apply);
			} else {
				await apply();
			}
		},
	};
}
