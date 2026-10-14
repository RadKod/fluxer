// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {
	REFERRAL_PENDING_COUNTER,
	REFERRAL_REJECTED_COUNTER,
	REFERRAL_VALID_COUNTER,
} from '@app/api/database/types/ReferralTypes';
import {createReferralCounterFlushers} from '@app/api/referral/ReferralCounters';
import {ReferralRepository} from '@app/api/referral/ReferralRepository';
import {describe, expect, it} from 'vitest';

const REFERRER = createUserID(1490000000000000100n);
const ID = REFERRER.toString();
const AT = new Date('2026-10-01T10:00:00Z');

describe('referral counters', () => {
	const repository = new ReferralRepository();
	const flushers = new Map(createReferralCounterFlushers(repository).map((flusher) => [flusher.namespace, flusher]));

	function flusher(namespace: string) {
		const found = flushers.get(namespace);
		if (!found) throw new Error(`no flusher for ${namespace}`);
		return found;
	}

	it('readBase/flush/recount for the three namespaces', async () => {
		expect([...flushers.keys()].sort()).toEqual(
			[REFERRAL_PENDING_COUNTER, REFERRAL_REJECTED_COUNTER, REFERRAL_VALID_COUNTER].sort(),
		);
		for (const namespace of flushers.keys()) expect(await flusher(namespace).readBase(ID)).toBe(0);

		await flusher(REFERRAL_VALID_COUNTER).flush(ID, 7);
		await flusher(REFERRAL_PENDING_COUNTER).flush(ID, 2);
		await flusher(REFERRAL_REJECTED_COUNTER).flush(ID, -1);
		expect(await flusher(REFERRAL_VALID_COUNTER).readBase(ID)).toBe(7);
		expect(await flusher(REFERRAL_PENDING_COUNTER).readBase(ID)).toBe(2);
		expect(await flusher(REFERRAL_REJECTED_COUNTER).readBase(ID)).toBe(0);

		const states = ['valid', 'valid', 'rejected', 'pending', 'valid'] as const;
		for (const [n, state] of states.entries()) {
			const refereeId = createUserID(1490000000000000200n + BigInt(n));
			const referredAt = new Date(AT.getTime() + n * 86_400_000);
			await repository.recordReferral(
				{refereeId, referrerId: REFERRER, referredAt, regIp: '203.0.113.1', riskBlocked: false},
				{dueAt: referredAt, ttlSeconds: 86_400},
			);
			if (state !== 'pending') {
				await repository.updateReferrerEntry(
					REFERRER,
					referredAt,
					refereeId,
					state,
					state === 'rejected' ? 'same_ip' : null,
				);
			}
		}
		expect(await flusher(REFERRAL_VALID_COUNTER).recount(ID)).toBe(3);
		expect(await flusher(REFERRAL_PENDING_COUNTER).recount(ID)).toBe(1);
		expect(await flusher(REFERRAL_REJECTED_COUNTER).recount(ID)).toBe(1);
	});
});
