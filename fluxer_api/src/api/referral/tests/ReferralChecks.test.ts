// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {
	REFERRAL_CHECK_SHARDS,
	REFERRAL_CHECK_SLOT_MS,
	referralCheckShard,
	referralCheckSlot,
} from '@app/api/database/types/ReferralTypes';
import {
	createRewardFixture,
	DAY_MS,
	daysAfter,
	REFERRER,
	type RewardFixture,
} from '@app/api/referral/tests/ReferralRewardTestUtils';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const CURSOR_KEY = 'referral:checks:cursor';
// 16 referees, one per check shard.
const REFEREES = Array.from({length: REFERRAL_CHECK_SHARDS}, (_, i) => 1490000000000000200n + BigInt(i));

describe('ReferralRewardService.reconcileChecks', () => {
	let f: RewardFixture;

	beforeEach(() => {
		f = createRewardFixture();
		f.addUser(REFERRER);
	});

	const queuedIds = () => f.jobs.filter((job) => job.task === 'evaluateReferral').map((job) => job.payload.referee_id);

	it('walks 16 shards from the cursor and queues one keyed job per due row', async () => {
		for (const id of REFEREES) await f.refer(id);
		const slot = referralCheckSlot(daysAfter(3));
		await f.kvClient.set(CURSOR_KEY, String(slot));

		const run = await f.service.reconcileChecks(new Date((slot + 2) * REFERRAL_CHECK_SLOT_MS));

		expect(run?.queued).toBe(16);
		expect(new Set(f.jobs.map((job) => (job.payload as {shard: number}).shard))).toEqual(
			new Set(Array.from({length: REFERRAL_CHECK_SHARDS}, (_, i) => i)),
		);
		const id = REFEREES[3]!;
		expect(f.jobs).toContainEqual({
			task: 'evaluateReferral',
			payload: {referee_id: id.toString(), slot, shard: referralCheckShard(id)},
			options: {jobKey: `${id}:${slot}`, skipLedger: true},
		});
	});

	it('reads closed slots only: a row of the current slot waits (rev 2 O3)', async () => {
		await f.refer(REFEREES[0]!);
		const slot = referralCheckSlot(daysAfter(3));
		await f.kvClient.set(CURSOR_KEY, String(slot));

		expect((await f.service.reconcileChecks(new Date(slot * REFERRAL_CHECK_SLOT_MS + 59 * 60_000)))?.queued).toBe(0);
		expect((await f.service.reconcileChecks(new Date((slot + 1) * REFERRAL_CHECK_SLOT_MS)))?.queued).toBe(1);
	});

	it('missing cursor starts at now − 14 days', async () => {
		const now = daysAfter(30);
		// Due 13 days before now: read. Due 15 days before: outside the start (its row TTL has ended anyway).
		await f.refer(REFEREES[0]!, {referredAt: new Date(now.getTime() - 16 * DAY_MS)});
		await f.refer(REFEREES[1]!, {referredAt: new Date(now.getTime() - 18 * DAY_MS)});

		await f.service.reconcileChecks(now);

		expect(queuedIds()).toEqual([REFEREES[0]!.toString()]);
		expect(await f.kvClient.get(CURSOR_KEY)).toBe(String(referralCheckSlot(new Date(now.getTime() - 13 * DAY_MS))));
	});

	it('a cursor older than 14 days (or garbage) starts at now − 14 days, never walks back further', async () => {
		const now = daysAfter(30);
		await f.refer(REFEREES[1]!, {referredAt: new Date(now.getTime() - 18 * DAY_MS)});
		const listChecks = vi.spyOn(f.repository, 'listChecks');

		for (const stale of ['0', 'x']) {
			await f.kvClient.set(CURSOR_KEY, stale);
			await f.service.reconcileChecks(now);
		}

		expect(queuedIds()).toEqual([]);
		expect(listChecks.mock.calls.length).toBe(2 * 14 * 24 * REFERRAL_CHECK_SHARDS);
	});

	it('cursor advances only past empty slots', async () => {
		await f.refer(REFEREES[0]!, {referredAt: daysAfter(0)});
		await f.refer(REFEREES[1]!, {referredAt: daysAfter(1)});
		const first = referralCheckSlot(daysAfter(3));
		await f.kvClient.set(CURSOR_KEY, String(first - 5));
		const now = daysAfter(5);

		await f.service.reconcileChecks(now);
		expect(await f.kvClient.get(CURSOR_KEY)).toBe(String(first));

		f.addUser(REFEREES[0]!);
		await f.service.evaluate(createUserID(REFEREES[0]!), {slot: first, shard: referralCheckShard(REFEREES[0]!)}, now);
		await f.service.reconcileChecks(now);
		expect(await f.kvClient.get(CURSOR_KEY)).toBe(String(referralCheckSlot(daysAfter(4))));

		f.addUser(REFEREES[1]!);
		await f.service.evaluate(
			createUserID(REFEREES[1]!),
			{slot: referralCheckSlot(daysAfter(4)), shard: referralCheckShard(REFEREES[1]!)},
			now,
		);
		const run = await f.service.reconcileChecks(now);
		expect(await f.kvClient.get(CURSOR_KEY)).toBe(String(referralCheckSlot(now)));
		expect(run?.lagSeconds).toBe(0);
	});

	it('a queued row is not queued again while its mark lives; the lag shows a held slot', async () => {
		await f.refer(REFEREES[0]!);
		const slot = referralCheckSlot(daysAfter(3));
		await f.kvClient.set(CURSOR_KEY, String(slot));
		const now = new Date((slot + 1) * REFERRAL_CHECK_SLOT_MS + 20 * 60_000);

		expect((await f.service.reconcileChecks(now))?.queued).toBe(1);
		const again = await f.service.reconcileChecks(now);

		expect(again?.queued).toBe(0);
		expect(again?.lagSeconds).toBe(20 * 60);
	});

	it('a walk stops at its time budget, before its lock runs out, and keeps the cursor where it stopped (V5)', async () => {
		vi.useFakeTimers({toFake: ['Date']});
		try {
			await f.refer(REFEREES[0]!, {referredAt: daysAfter(0)});
			await f.refer(REFEREES[1]!, {referredAt: daysAfter(1)});
			const start = referralCheckSlot(daysAfter(3)) - 5;
			await f.kvClient.set(CURSOR_KEY, String(start));
			const listChecks = f.repository.listChecks.bind(f.repository);
			vi.spyOn(f.repository, 'listChecks').mockImplementation(async (...args) => {
				vi.setSystemTime(Date.now() + 51_000);
				return listChecks(...args);
			});

			const run = await f.service.reconcileChecks(daysAfter(5));

			expect(run?.queued).toBe(0);
			expect(f.repository.listChecks).toHaveBeenCalledTimes(1);
			expect(await f.kvClient.get(CURSOR_KEY)).toBe(String(start));
		} finally {
			vi.useRealTimers();
		}
	});

	it('one run at a time', async () => {
		await f.kvClient.acquireLock('referral:checks:lock', 'other-run', 60);
		expect(await f.service.reconcileChecks(daysAfter(5))).toBeNull();
	});
});
