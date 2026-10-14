// SPDX-License-Identifier: AGPL-3.0-or-later

import {notifyMicupBotReaction} from '@app/api/guild/micupbot/MicupBotReactionHook';
import {notifyGuildRosterReaction} from '@app/api/guild/roster/GuildRosterReactionHook';
import type {GuildRosterReactionChange} from '@app/api/guild/roster/GuildRosterService';
import {Logger} from '@app/api/Logger';

function warnHookFailure(error: unknown): void {
	try {
		Logger.warn({error}, 'Official bot reaction hook failed');
	} catch {
		// Logging must not fail the reaction or prevent the other bot's hook.
	}
}

export function notifyOfficialBotReaction(change: GuildRosterReactionChange): void {
	try {
		notifyGuildRosterReaction(change);
	} catch (error) {
		warnHookFailure(error);
	}
	try {
		notifyMicupBotReaction(change);
	} catch (error) {
		warnHookFailure(error);
	}
}
