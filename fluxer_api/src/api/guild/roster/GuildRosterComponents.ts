// SPDX-License-Identifier: AGPL-3.0-or-later

import type {OfficialBotComponentClick, OfficialBotComponentReply} from '@app/api/guild/OfficialBotComponentRouter';
import {isOfficialBotInGuild} from '@app/api/guild/OfficialBots';
import {rosterBotUserId} from '@app/api/guild/roster/GuildRosterBot';
import {ROSTER_BUTTON_IDS, ROSTER_JOIN_EMOJI} from '@app/api/guild/roster/GuildRosterConstants';
import {GuildRosterService} from '@app/api/guild/roster/GuildRosterService';
import {Logger} from '@app/api/Logger';
import {getKVClient, getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getChannelRepository, getGuildRepository} from '@app/api/middleware/ServiceSingletons';
import type {MessageComponentReplyCode} from '@fluxer/constants/src/MessageComponentConstants';

type JoinResult = Awaited<ReturnType<GuildRosterService['join']>>;
type LeaveResult = Awaited<ReturnType<GuildRosterService['leave']>>;
const JOIN_REPLIES: Record<JoinResult, MessageComponentReplyCode> = {
	joined: 'roster_joined',
	already: 'roster_already_joined',
	busy: 'roster_busy',
	full: 'roster_full',
	closed: 'roster_closed',
	unknown: 'roster_closed',
};
const LEAVE_REPLIES: Record<LeaveResult, MessageComponentReplyCode> = {
	left: 'roster_left',
	absent: 'roster_not_joined',
	closed: 'roster_closed',
	unknown: 'roster_closed',
};

// Join and Leave take the same event lock as the ✅ reaction and write before the reply; only a Join that adds the
// member marks them, in the same write. Full, closed and repeated Joins answer without the lock.
// TEMPORARY: a Join that may write still waits for the event lock (8 jittered waits, ≤ 0.4 s) and otherwise
// gets Fluxer's ResourceLockedError; the member clicks again. Risks at 10 M: every guild's:25 rush lands on the one
// Valkey Fluxer shares for sessions and rate limits (lock retries × guilds), and ✅ syncs waiting up to 2 s on the same
// lock hold roster_live lane slots (16) so card renders of other guilds starve. Trigger: Join p95 > 500 ms,
// ResourceLocked > 1 % of clicks, Valkey ops/s > 60 % or roster_live num_ack_pending > 80 %. Path: the join as one Lua
// script without the lock (per-roster keys hash-tagged for a Valkey cluster), then a process per roster lane.
export async function handleGuildRosterComponent(click: OfficialBotComponentClick): Promise<OfficialBotComponentReply> {
	const botId = rosterBotUserId();
	if (!botId || !(await isOfficialBotInGuild(getGuildRepository(), botId, click.guildId)))
		return {code: 'component_unavailable'};
	const roster = new GuildRosterService({kvClient: getKVClient(), workerService: getWorkerService()});
	const ref = await roster.lookupMessage(click.message.id);
	if (!ref) return {code: 'roster_closed'};
	if (ref.guildId !== click.guildId) return {code: 'component_unavailable'};
	const userId = click.user.id;
	const card = {messageId: click.message.id};
	let code: MessageComponentReplyCode;
	if (click.customId === ROSTER_BUTTON_IDS.join) code = JOIN_REPLIES[await roster.join(ref, userId, click.atMs, card)];
	else if (click.customId === ROSTER_BUTTON_IDS.leave) {
		const result = await roster.leave(ref, userId, card);
		// Also after `absent`: a retry of a Leave whose reply was lost still takes the ✅ back.
		if (result === 'left' || result === 'absent') await removeOwnCheckMark(click);
		code = LEAVE_REPLIES[result];
	} else return {code: 'component_unavailable'};
	// Also after a no-op: a retry flushes a render whose queueing failed on the first click.
	await roster.flushRender(ref, Date.now());
	return {code};
}

// Leave also takes back the clicker's own ✅ through Fluxer's remove-own-reaction service (their own reaction, no bot
// permission), so a redelivered reaction sync cannot add them again. Without a ✅ nothing is written or dispatched.
async function removeOwnCheckMark({
	viewer,
	channelService,
	channelId,
	message,
	user,
	requestCache,
}: OfficialBotComponentClick) {
	const channels = getChannelRepository();
	try {
		for (const emoji of [ROSTER_JOIN_EMOJI, `${ROSTER_JOIN_EMOJI}\uFE0F`])
			if (await channels.messageInteractions.checkUserReactionExists(channelId, message.id, user.id, emoji, undefined))
				await channelService.interactions.removeOwnReaction({
					viewer,
					userId: user.id,
					channelId,
					messageId: message.id,
					emoji,
					requestCache,
				});
	} catch (error) {
		// The member already left; a ✅ that stays (e.g. reactions switched off in the community) is only logged.
		Logger.warn({error}, 'Roster Leave could not remove the reaction');
	}
}
