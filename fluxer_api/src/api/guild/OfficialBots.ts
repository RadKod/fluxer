// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import type {GuildRepository} from '@app/api/guild/repositories/GuildRepository';
import {rosterBotUserId} from '@app/api/guild/roster/GuildRosterBot';

// The configured first-party bots may write message buttons (Roster; MicupBOT later).
export function isOfficialComponentBot(userId: UserID): boolean {
	return userId === rosterBotUserId();
}

// TEMPORARY: per-process 30 s cache, at most 50 000 entries: a kicked bot may still get clicks
// for 30 s, and writing as the bot is refused by Fluxer anyway. Trigger: guild_members read p99 > 500 ms or a miss rate
// > 5 %. Path: a shared @pkgs/cache entry invalidated by the bot's guild leave. Only a positive result is cached, so a
// re-added bot answers clicks at once.
const MEMBERSHIP_TTL_MS = 30_000;
const MEMBERSHIP_MAX_ENTRIES = 50_000;
const membership = new Map<string, {value: boolean; expiresAt: number}>();

export async function isOfficialBotInGuild(
	guildRepository: Pick<GuildRepository, 'getMember'>,
	botId: UserID,
	guildId: GuildID,
): Promise<boolean> {
	const key = `${guildId}:${botId}`;
	const now = Date.now();
	const cached = membership.get(key);
	if (cached && now < cached.expiresAt) return cached.value;
	const value = (await guildRepository.getMember(guildId, botId)) !== null;
	membership.delete(key);
	if (!value) return false;
	const oldest = membership.keys().next().value;
	if (oldest !== undefined && membership.size >= MEMBERSHIP_MAX_ENTRIES) membership.delete(oldest);
	membership.set(key, {value, expiresAt: now + MEMBERSHIP_TTL_MS});
	return value;
}
