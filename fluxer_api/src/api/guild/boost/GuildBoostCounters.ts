// SPDX-License-Identifier: AGPL-3.0-or-later

import {createGuildID} from '@app/api/BrandedTypes';
import type {GuildBoostRepository} from '@app/api/guild/boost/GuildBoostRepository';
import type {CounterFlusher} from '@app/api/infrastructure/KVCounterService';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';

export const GUILD_BOOST_COUNT_COUNTER = 'guild_boost_count';
const RECOUNT_PAGE_SIZE = 5000;
const RECOUNT_SLOT_READ_CONCURRENCY = 16;

// The boost count lives in the KV counter (KV counter); the guild row only gets the flushed value, so boosting never writes
// the hot guild row on the request path.
export function createGuildBoostCounterFlushers(repository: GuildBoostRepository): Array<CounterFlusher> {
	return [
		{
			namespace: GUILD_BOOST_COUNT_COUNTER,
			async readBase(id) {
				return (await repository.findBoostCount(createGuildID(BigInt(id)))) ?? 0;
			},
			async flush(id, value) {
				const guildId = createGuildID(BigInt(id));
				const count = Math.max(0, value);
				const stored = await repository.findBoostCount(guildId);
				// A missing row means the guild was deleted; writing would resurrect it as a partial row.
				if (stored !== null && stored !== count) {
					await repository.setBoostCount(guildId, count);
				}
			},
			// Repair only (RebuildCounter): counts the rows whose slot still backs them and drops the rest, which a crash
			// between the slot write and the boost row write can leave behind.
			async recount(id) {
				const guildId = createGuildID(BigInt(id));
				let count = 0;
				let after: bigint | undefined;
				for (;;) {
					const page = await repository.listBoostsAfter(guildId, RECOUNT_PAGE_SIZE, after);
					const backed = await mapWithConcurrency(page, RECOUNT_SLOT_READ_CONCURRENCY, async (row) => {
						const slot = await repository.getSlot(row.user_id, row.slot_id);
						if (slot?.guild_id === row.guild_id && slot.boost_id === row.boost_id) {
							return true;
						}
						await repository.deleteBoost(row.guild_id, row.boost_id);
						return false;
					});
					count += backed.filter(Boolean).length;
					if (page.length < RECOUNT_PAGE_SIZE) {
						return count;
					}
					after = page[page.length - 1]!.boost_id;
				}
			},
		},
	];
}
