// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID, createUserID} from '@app/api/BrandedTypes';
import {BatchBuilder} from '@app/api/database/CassandraQueryExecution';
import {MICUPBOT_XP_COUNTER, MICUPBOT_XP_DIRTY_SET, micupBotLevelBucket} from '@app/api/database/types/MicupBotTypes';
import type {MicupBotRepository} from '@app/api/guild/micupbot/MicupBotRepository';
import {MicupBotMemberLevels, MicupBotUserGuilds} from '@app/api/guild/micupbot/MicupBotTables';
import type {CounterFlusher} from '@app/api/infrastructure/KVCounterService';
export function createMicupBotXpCounterFlusher(repository: MicupBotRepository): CounterFlusher {
	const ids = (id: string) => {
		const [guild, user] = id.split(':');
		return {guildId: createGuildID(BigInt(guild)), userId: createUserID(BigInt(user))};
	};
	const readBase = async (id: string) => {
		const {guildId, userId} = ids(id);
		return Number((await repository.getMemberXp(guildId, userId)) ?? 0n);
	};
	return {
		namespace: MICUPBOT_XP_COUNTER,
		dirtySet: MICUPBOT_XP_DIRTY_SET,
		readBase,
		recount: readBase,
		async flush(id, value) {
			const {guildId, userId} = ids(id);
			const updated_at = new Date();
			await new BatchBuilder()
				.addPrepared(
					MicupBotMemberLevels.upsertAll({
						guild_id: guildId,
						bucket: micupBotLevelBucket(userId),
						user_id: userId,
						xp: BigInt(Math.max(0, value)),
						updated_at,
					}),
				)
				.addPrepared(MicupBotUserGuilds.upsertAll({user_id: userId, guild_id: guildId, updated_at}))
				.execute();
		},
	};
}
