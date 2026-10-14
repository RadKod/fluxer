// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {isMicupBotLive, micupBotUserId} from '@app/api/guild/micupbot/MicupBotBot';
import {MICUPBOT_HOOK_INFLIGHT_MAX} from '@app/api/guild/micupbot/MicupBotConstants';
import type {MicupBotMemberEventPayload} from '@app/api/guild/micupbot/MicupBotMemberEvents';
import {getMicupBotGuildConfig} from '@app/api/guild/micupbot/MicupBotSettingsCache';
import {Logger} from '@app/api/Logger';
import {getWorkerService} from '@app/api/middleware/ServiceRegistry';
import {getLimitConfigService} from '@app/api/middleware/ServiceSingletons';
import type {Guild} from '@app/api/models/Guild';
import type {User} from '@app/api/models/User';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';

let inFlight = 0;
let skipped = 0;
let lastCapacityWarning = -Infinity;

export function warnMicupBotHookFailure(error: unknown): void {
	try {
		Logger.warn({error}, 'MicupBOT member or reaction hook failed');
	} catch {
		// A failed logger must not fail the successful membership or reaction operation.
	}
}

// H2, H3 and H4 share the pending-work ceiling, including H3's asynchronous settings lookup.
export function runMicupBotHook(work: () => Promise<unknown>): void {
	try {
		if (inFlight >= MICUPBOT_HOOK_INFLIGHT_MAX) {
			skipped++;
			const now = Date.now();
			if (now - lastCapacityWarning >= 60_000) {
				Logger.warn({hook_skipped: skipped}, 'MicupBOT hook capacity exceeded');
				skipped = 0;
				lastCapacityWarning = now;
			}
			return;
		}
		inFlight++;
		void (async () => {
			try {
				await work();
			} catch (error) {
				warnMicupBotHookFailure(error);
			} finally {
				inFlight--;
			}
		})();
	} catch (error) {
		warnMicupBotHookFailure(error);
	}
}

function enqueue(payload: MicupBotMemberEventPayload): Promise<bigint> {
	return getWorkerService().addJob(
		'handleMicupBotMemberEvent',
		{...payload},
		{
			jobKey: `${payload.kind}:${payload.guild_id}:${payload.user_id}:${payload.at}`,
			skipLedger: true,
		},
	);
}

export function notifyMicupBotMemberJoin(p: {guild: Guild; userId: UserID; user: User; isTemporary: boolean}): void {
	try {
		const kind = p.userId === micupBotUserId() ? 'bot_join' : 'join';
		if (kind === 'join' && !isMicupBotLive(getLimitConfigService())) return;
		if (kind === 'join' && (p.user.isBot || p.isTemporary || !p.guild.features.has(GuildFeatures.MICUPBOT_JOIN)))
			return;
		const payload: MicupBotMemberEventPayload = {
			kind,
			guild_id: String(p.guild.id),
			user_id: String(p.userId),
			temporary: p.isTemporary,
			at: Date.now(),
		};
		runMicupBotHook(() => enqueue(payload));
	} catch (error) {
		warnMicupBotHookFailure(error);
	}
}

export function notifyMicupBotMemberLeave(p: {
	guildId: GuildID;
	userId: UserID;
	removed: boolean;
	temporary: boolean;
}): void {
	try {
		if (!p.removed) return;
		const kind = p.userId === micupBotUserId() ? 'bot_leave' : 'leave';
		if (kind === 'leave' && !isMicupBotLive(getLimitConfigService())) return;
		if (kind === 'leave' && p.temporary) return;
		const payload: MicupBotMemberEventPayload = {
			kind,
			guild_id: String(p.guildId),
			user_id: String(p.userId),
			temporary: p.temporary,
			at: Date.now(),
		};
		runMicupBotHook(async () => {
			// TEMPORARY: above 1,000 cache-miss GET/s, carry guild.features into departure paths.
			if (kind === 'leave' && !(await getMicupBotGuildConfig(p.guildId))?.settings.goodbye_enabled) return;
			await enqueue(payload);
		});
	} catch (error) {
		warnMicupBotHookFailure(error);
	}
}
