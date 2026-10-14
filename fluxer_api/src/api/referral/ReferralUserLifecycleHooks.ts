// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {
	REFERRAL_PENDING_COUNTER,
	REFERRAL_REJECTED_COUNTER,
	REFERRAL_VALID_COUNTER,
} from '@app/api/database/types/ReferralTypes';
import {counterKey} from '@app/api/infrastructure/KVCounterService';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import {getKVCounterService, getReferralRepository, getUserRepository} from '@app/api/middleware/ServiceSingletons';
import {registerUserDeletionHook, registerUserHarvestHook} from '@app/api/user/lifecycle/UserLifecycleHooks';
import {UserFlags} from '@fluxer/constants/src/UserConstants';

// a pending referral of a deleted account is rejected as account_gone once (LWT) and moves from the
// referrer's pending count to rejected; a valid one is never taken back, and the referrer's list keeps the entry,
// an ID only. A deleted referrer's rows are already gone, so nothing is written back for it. Then every row of
// the account itself goes (code, mapping, check, rewards, stats, bands, own list) with its KV counters.
// TEMPORARY: a crash between the state change and the counter moves loses that move; the counter recount repairs it.
async function deleteUserReferrals(userId: UserID): Promise<void> {
	const repository = getReferralRepository();
	const own = await repository.getUserReferral(userId);
	if (own?.referrer_id && own.referred_at && own.state === 'pending') {
		const decided = await repository.transitionState(userId, 'rejected', 'account_gone', new Date());
		const referrer = decided ? await getUserRepository().findUnique(own.referrer_id) : null;
		if (referrer && (referrer.flags & (UserFlags.DELETED | UserFlags.SELF_DELETED)) === 0n) {
			await repository.updateReferrerEntry(own.referrer_id, own.referred_at, userId, 'rejected', 'account_gone');
			const counters = getKVCounterService();
			const referrerId = own.referrer_id.toString();
			await counters.add(REFERRAL_PENDING_COUNTER, referrerId, -1);
			await counters.add(REFERRAL_REJECTED_COUNTER, referrerId, 1);
		}
	}
	await deleteCounters(userId);
	await repository.deleteAllForUser(userId);
}

// One key at a time: the three counters hash to different cluster slots.
async function deleteCounters(userId: UserID): Promise<void> {
	const kv = getKVClient();
	for (const namespace of [REFERRAL_VALID_COUNTER, REFERRAL_PENDING_COUNTER, REFERRAL_REJECTED_COUNTER]) {
		await kv.del(counterKey(namespace, userId.toString()));
	}
}

// No ban hook: a banned referee keeps the referrer's count.
export function registerReferralUserLifecycleHooks(): void {
	registerUserDeletionHook('referral', ({userId}) => deleteUserReferrals(userId));
	// the export says whether an off-site code was delivered, never the code itself; no IP.
	registerUserHarvestHook('referral', ({userId}) => getReferralRepository().harvest(userId));
}
