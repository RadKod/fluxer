// SPDX-License-Identifier: AGPL-3.0-or-later

import {isMicupBotLive, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {runMicupBotHook, warnMicupBotHookFailure} from '@app/api/guild/micupbot/MicupBotMemberHooks';
import type {GuildRosterReactionChange} from '@app/api/guild/roster/GuildRosterService';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';

export type MicupBotReactionChange = GuildRosterReactionChange;
export function notifyMicupBotReaction(change: MicupBotReactionChange): void {
	try {
		if (!change.guildId) return;
		const botId = micupBotUserId();
		if (!botId || change.authorId !== botId || change.kind === 'clear' || change.userId === botId) return;
		if (!isMicupBotLive(getLimitConfigService())) return;
		const payload = {
			kind: change.kind,
			guild_id: String(change.guildId),
			channel_id: String(change.channelId),
			message_id: String(change.messageId),
			user_id: String(change.userId),
			emoji_name: change.emojiName,
			emoji_id: change.emojiId?.toString() ?? null,
			at: change.atMs,
		};
		runMicupBotHook(() =>
			getWorkerService().addJob('applyMicupBotReactionRole', payload, {
				jobKey: `rr:${payload.message_id}:${payload.user_id}:${payload.emoji_id ?? payload.emoji_name}:${payload.at}`,
				skipLedger: true,
			}),
		);
	} catch (error) {
		warnMicupBotHookFailure(error);
	}
}
