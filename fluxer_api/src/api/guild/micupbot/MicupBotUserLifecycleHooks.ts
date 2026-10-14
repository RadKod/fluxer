// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import {MICUPBOT_XP_COUNTER, MICUPBOT_XP_DIRTY_SET, micupBotXpCounterId} from '@app/api/database/types/MicupBotTypes';
import {MICUPBOT_LIMITS} from '@app/api/guild/micupbot/MicupBotConstants';
import {leaderboardRemove} from '@app/api/guild/micupbot/MicupBotLeaderboard';
import {levelFromXp} from '@app/api/guild/micupbot/MicupBotXp';
import {
	counterDirtyKey,
	counterInflightKey,
	counterKey,
	counterPartition,
} from '@app/api/infrastructure/KVCounterService';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getKVCounterService, getMicupBotRepository} from '@app/api/middleware/ServiceSingletons';
import {registerUserDeletionHook, registerUserHarvestHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';

async function deleteMicupBotUser(userId: UserID): Promise<void> {
	const repository = getMicupBotRepository(),
		kv = getKVClient();
	for (const guildId of await repository.listUserGuilds(userId)) {
		const id = micupBotXpCounterId(guildId, userId);
		const partition = counterPartition(MICUPBOT_XP_COUNTER, id);
		// Use flushPartition's lock so a flush that already read the XP cannot recreate a deleted row.
		// Contention fails this lifecycle attempt; its retry still has the reverse index to finish deletion.
		const lockKey = `job:flushCounters:${MICUPBOT_XP_DIRTY_SET}:{${partition}}`,
			token = randomUUID();
		if (!(await kv.acquireLock(lockKey, token, 60))) throw new ResourceLockedError();
		try {
			const member = `${MICUPBOT_XP_COUNTER}:${id}`;
			await kv.srem(counterDirtyKey(partition, MICUPBOT_XP_DIRTY_SET), member);
			await kv.srem(counterInflightKey(partition, MICUPBOT_XP_DIRTY_SET), member);
			if (!(await kv.extendLock(lockKey, token, 60))) throw new ResourceLockedError();
			await kv.del(counterKey(MICUPBOT_XP_COUNTER, id));
		} finally {
			await kv.releaseLock(lockKey, token);
		}
		await leaderboardRemove(kv, guildId, userId);
		await repository.deleteMemberLevel(guildId, userId);
		await repository.deleteWarnings(guildId, userId);
	}
	await repository.deleteUserGuilds(userId);
}

async function harvestMicupBotUser(userId: UserID) {
	const repository = getMicupBotRepository(),
		counters = getKVCounterService();
	const result = [];
	for (const guildId of await repository.listUserGuilds(userId)) {
		const xp = await counters.get(MICUPBOT_XP_COUNTER, micupBotXpCounterId(guildId, userId));
		const warnings = await repository.listWarnings(guildId, userId, MICUPBOT_LIMITS.warningsMax);
		result.push({
			guild_id: String(guildId),
			xp,
			level: levelFromXp(xp).level,
			warnings: warnings.map(({reason, created_at}) => ({reason, created_at: created_at.toISOString()})),
		});
	}
	return result;
}

export function registerMicupBotUserLifecycleHooks(): void {
	registerUserDeletionHook('micupbot', ({userId}) => deleteMicupBotUser(userId));
	registerUserHarvestHook('micupbot', ({userId}) => harvestMicupBotUser(userId));
}
