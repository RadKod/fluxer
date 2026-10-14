// SPDX-License-Identifier: AGPL-3.0-or-later

import {rosterBotUserId} from '@app/api/guild/roster/GuildRosterBot';
import {ROSTER_JOIN_EMOJI, ROSTER_STATE_TTL_SECONDS} from '@app/api/guild/roster/GuildRosterConstants';
import type {GuildRosterReactionChange} from '@app/api/guild/roster/GuildRosterService';
import {Logger} from '@app/api/Logger';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {snowflakeToDate} from '@fluxer/snowflake/src/Snowflake';

function warnQueueFailure(error: unknown): void {
	try {
		Logger.warn({error}, 'Roster reaction enqueue failed');
	} catch {
		// Even an unavailable logger must not turn a successful reaction into an HTTP failure.
	}
}

export function notifyGuildRosterReaction(change: GuildRosterReactionChange): void {
	try {
		if (!change.guildId) return;
		const botId = rosterBotUserId();
		if (!botId || change.authorId !== botId) return;
		if (change.kind !== 'clear' && change.userId === botId) return;
		if (change.emojiId !== undefined) return;
		if (
			change.emojiName?.replaceAll('\uFE0F', '') !== ROSTER_JOIN_EMOJI &&
			!(change.kind === 'clear' && change.emojiName === null)
		)
			return;
		if (Date.now() - snowflakeToDate(change.messageId).getTime() > ROSTER_STATE_TTL_SECONDS * 1000) return;
		const userId = change.kind === 'clear' ? undefined : change.userId.toString();
		void getWorkerService()
			.addJob(
				'syncGuildRosterReaction',
				{
					kind: change.kind,
					guild_id: change.guildId.toString(),
					channel_id: change.channelId.toString(),
					message_id: change.messageId.toString(),
					...(userId ? {user_id: userId} : {}),
					at: change.atMs,
				},
				{jobKey: `${change.messageId}:${userId ?? 'all'}:${change.kind}:${change.atMs}`, skipLedger: true},
			)
			.catch(warnQueueFailure);
	} catch (error) {
		warnQueueFailure(error);
	}
}
