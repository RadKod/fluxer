// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {
	REFERRAL_PENDING_COUNTER,
	REFERRAL_REJECTED_COUNTER,
	REFERRAL_VALID_COUNTER,
	type ReferralState,
	type ReferralStatsRow,
} from '@app/api/database/types/ReferralTypes';
import type {CounterFlusher} from '@app/api/infrastructure/KVCounterService';
import type {ReferralRepository, ReferralStatsField} from '@app/api/referral/ReferralRepository';

const RECOUNT_PAGE_SIZE = 5000;

// A referrer's valid, pending and rejected counts, with their bases in one referral_stats row. recount runs only from
// the RebuildCounter worker task.
// TEMPORARY: a recount walks the referrer's whole list (one row per referral). Trigger: a referrer passes 10^5
// referrals and a rebuild is needed. Path: count per day bucket and keep the bucket sums.
export function createReferralCounterFlushers(repository: ReferralRepository): Array<CounterFlusher> {
	const userId = (id: string) => createUserID(BigInt(id));
	// The three bases share one row, so the three base reads of one view (a KV miss on each) share one Cassandra read.
	const inflightStats = new Map<string, Promise<ReferralStatsRow | null>>();
	const readStats = (id: string): Promise<ReferralStatsRow | null> => {
		let pending = inflightStats.get(id);
		if (!pending) {
			pending = repository.getStats(userId(id)).finally(() => inflightStats.delete(id));
			inflightStats.set(id, pending);
		}
		return pending;
	};
	const counter = (namespace: string, field: ReferralStatsField, state: ReferralState): CounterFlusher => ({
		namespace,
		async readBase(id) {
			return Number((await readStats(id))?.[field] ?? 0n);
		},
		async flush(id, value) {
			await repository.writeStatsField(userId(id), field, Math.max(0, value));
		},
		async recount(id) {
			let count = 0;
			let cursor: string | null = null;
			do {
				const page = await repository.listReferrals(userId(id), cursor, RECOUNT_PAGE_SIZE);
				count += page.items.filter((row) => row.state === state).length;
				cursor = page.nextCursor;
			} while (cursor !== null);
			return count;
		},
	});
	return [
		counter(REFERRAL_VALID_COUNTER, 'valid_count', 'valid'),
		counter(REFERRAL_PENDING_COUNTER, 'pending_count', 'pending'),
		counter(REFERRAL_REJECTED_COUNTER, 'rejected_count', 'rejected'),
	];
}
