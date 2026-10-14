// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {referralCheckShard, referralCheckSlot} from '@app/api/database/types/ReferralTypes';
import {REGISTRATION_PENDING_APPROVAL_TRAIT} from '@app/api/instance/InstanceConfigRepository';
import {
	createRewardFixture,
	DAY_MS,
	daysAfter,
	REFERRED_AT,
	REFERRER,
	type RewardFixture,
} from '@app/api/referral/tests/ReferralRewardTestUtils';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const REFEREE = 1490000000000000201n;

describe('ReferralRewardService.evaluate', () => {
	let f: RewardFixture;

	beforeEach(() => {
		f = createRewardFixture();
		f.addUser(REFERRER, {email: 'owner@example.com'});
	});

	const at = (dueAt: Date) => ({slot: referralCheckSlot(dueAt), shard: referralCheckShard(REFEREE)});
	const evaluate = (dueAt: Date, now: Date) => f.service.evaluate(createUserID(REFEREE), at(dueAt), now);
	const state = async () => (await f.repository.getUserReferral(createUserID(REFEREE)))?.state;
	const reason = async () => (await f.repository.getUserReferral(createUserID(REFEREE)))?.reason;
	// Every check row of the referee in the slots a test can move it to (14 days on from referral).
	async function checkRows() {
		const rows = [];
		for (let day = 0; day <= 40; day++) {
			const slot = referralCheckSlot(daysAfter(day));
			for (let s = slot; s < slot + 24; s++) {
				rows.push(...(await f.repository.listChecks(s, referralCheckShard(REFEREE), 10)));
			}
		}
		return rows.filter((row) => row.referee_id === REFEREE);
	}

	it('verified + active N days → valid, counters move once, a grant job is queued', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE);

		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('valid');

		expect(await state()).toBe('valid');
		expect(await f.counts()).toEqual({valid: 1, pending: 0, rejected: 0});
		expect(f.jobs).toEqual([
			{
				task: 'grantReferralRewards',
				payload: {user_id: REFERRER.toString()},
				options: {jobKey: `${REFERRER}:1`, skipLedger: true},
			},
		]);
		expect(await f.repository.listBand(0, Number(REFERRER % 64n), 10)).toEqual([
			expect.objectContaining({user_id: REFERRER}),
		]);
		const [entry] = (await f.repository.listReferrals(REFERRER, null, 10)).items;
		expect(entry).toMatchObject({state: 'valid'});
	});

	it('the switch being off does not stop evaluation (rev 2 D5)', async () => {
		expect(f.config.enabled).toBe(false);
		f.addUser(REFEREE);
		expect(await evaluate(await f.refer(REFEREE), daysAfter(3.1))).toBe('valid');
	});

	it('two concurrent evaluates → +1 once', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE);

		const results = await Promise.all([evaluate(dueAt, daysAfter(3.1)), evaluate(dueAt, daysAfter(3.1))]);

		expect(results).toContain('valid');
		expect(await f.counts()).toEqual({valid: 1, pending: 0, rejected: 0});
		expect(f.jobs.filter((job) => job.task === 'grantReferralRewards')).toHaveLength(1);
	});

	it('reg_ip cleared after decision: the check row and the IP it carries are gone', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE, {regIp: '203.0.113.9'});
		expect((await checkRows())[0]?.reg_ip).toBe('203.0.113.9');

		await evaluate(dueAt, daysAfter(3.1));

		expect(await checkRows()).toEqual([]);
		expect(Object.values((await f.repository.getUserReferral(createUserID(REFEREE)))!)).not.toContain('203.0.113.9');
	});

	it.each([
		[
			'same_ip: the registration IP is one of the referrer’s',
			(fx: RewardFixture) => fx.authorizedIps.set(REFERRER, new Set(['203.0.113.9'])),
			'same_ip',
		],
		[
			'same_ip: the last IP is one of the referrer’s',
			(fx: RewardFixture) => {
				fx.users.get(REFEREE)!.lastActiveIp = '192.0.2.44';
				fx.authorizedIps.set(REFERRER, new Set(['192.0.2.44']));
			},
			'same_ip',
		],
		[
			'ip_velocity: more than K registrations from the IP in 30 days',
			(fx: RewardFixture) => {
				for (let i = 0; i < 4; i++) {
					fx.registrations.push({
						userId: String(i),
						email: null,
						emailDomain: null,
						ip: '203.0.113.9',
						locale: null,
						createdAt: new Date(REFERRED_AT.getTime() - i * DAY_MS),
					});
				}
			},
			'ip_velocity',
		],
		[
			'same_email: the plus-address base matches',
			(fx: RewardFixture) => {
				fx.users.get(REFEREE)!.email = 'Owner+alt@example.com';
			},
			'same_email',
		],
		[
			'account_gone: the referee was deleted',
			(fx: RewardFixture) => (fx.users.get(REFEREE)!.flags = UserFlags.DELETED),
			'account_gone',
		],
	] as const)('%s → rejected, counters moved once', async (_name, arrange, expected) => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE, {regIp: '203.0.113.9'});
		arrange(f);

		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('rejected');

		expect(await state()).toBe('rejected');
		expect(await reason()).toBe(expected);
		expect(await f.counts()).toEqual({valid: 0, pending: 0, rejected: 1});
		expect(await checkRows()).toEqual([]);
		expect(f.jobs).toEqual([]);
	});

	it('risk: an account Fluxer kept out of auto-join is rejected', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE, {riskBlocked: true});
		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('rejected');
		expect(await reason()).toBe('risk');
	});

	it('IPv6: registrations are counted under the /64 key', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE, {regIp: '2001:db8:1:2::1'});
		for (const ip of ['2001:db8:1:2::5', '2001:db8:1:2::6', '2001:db8:1:2::7', '2001:db8:1:3::8', '2001:db8:1:4::9']) {
			f.registrations.push({userId: ip, email: null, emailDomain: null, ip, locale: null, createdAt: REFERRED_AT});
		}
		// 3 registrations in the /64 (the other /64s do not count): within K = 3.
		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('valid');

		const other = 1490000000000000202n;
		f.addUser(other);
		const due2 = await f.refer(other, {regIp: '2001:db8:1:2::1'});
		f.registrations.push({
			userId: 'x',
			email: null,
			emailDomain: null,
			ip: '2001:db8:1:2::abcd',
			locale: null,
			createdAt: REFERRED_AT,
		});
		expect(
			await f.service.evaluate(
				createUserID(other),
				{slot: referralCheckSlot(due2), shard: referralCheckShard(other)},
				daysAfter(3.1),
			),
		).toBe('rejected');
		expect((await f.repository.getUserReferral(createUserID(other)))?.reason).toBe('ip_velocity');
	});

	it('unverified on day N → rescheduled a day later, rejected after N+14', async () => {
		f.addUser(REFEREE, {emailVerified: false});
		let dueAt = await f.refer(REFEREE);

		for (let day = 3; day < 17; day++) {
			const now = new Date(dueAt.getTime() + 60_000);
			expect(await evaluate(dueAt, now)).toBe('retry');
			const [row] = await checkRows();
			expect(row!.due_at).toEqual(new Date(now.getTime() + DAY_MS));
			dueAt = row!.due_at;
		}
		expect(await state()).toBe('pending');
		expect(await evaluate(dueAt, new Date(dueAt.getTime() + 60_000))).toBe('rejected');
		expect(await reason()).toBe('unverified');
		expect(await f.counts()).toEqual({valid: 0, pending: 0, rejected: 1});
	});

	it('inactive since registration → rejected as inactive once the window ends', async () => {
		f.addUser(REFEREE, {lastActiveAt: daysAfter(1)});
		const dueAt = await f.refer(REFEREE);
		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('retry');
		const [row] = await checkRows();
		expect(await evaluate(row!.due_at, daysAfter(17))).toBe('rejected');
		expect(await reason()).toBe('inactive');
	});

	it('an account waiting for approval is held, never counted', async () => {
		f.addUser(REFEREE, {traits: new Set([REGISTRATION_PENDING_APPROVAL_TRAIT])});
		expect(await evaluate(await f.refer(REFEREE), daysAfter(3.1))).toBe('retry');
		expect(await f.counts()).toEqual({valid: 0, pending: 1, rejected: 0});
	});

	it('an unsatisfied legacy phone requirement holds the row then rejects as risk despite limit exemption', async () => {
		const referee = f.addUser(REFEREE, {flags: UserFlags.LIMIT_EXEMPT});
		Object.assign(referee, {suspiciousActivityFlags: 4, hasVerifiedPhone: false});
		const dueAt = await f.refer(REFEREE);
		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('retry');
		expect(await f.counts()).toEqual({valid: 0, pending: 1, rejected: 0});
		expect(f.jobs).toEqual([]);
		const [row] = await checkRows();
		expect(await evaluate(row!.due_at, daysAfter(17))).toBe('rejected');
		expect(await state()).toBe('rejected');
		expect(await reason()).toBe('risk');
		expect(await f.counts()).toEqual({valid: 0, pending: 0, rejected: 1});
		expect(await checkRows()).toEqual([]);
		expect(f.jobs).toEqual([]);
	});

	it('a verified phone satisfies the legacy requirement and queues referral rewards once', async () => {
		const referee = f.addUser(REFEREE, {flags: UserFlags.LIMIT_EXEMPT});
		Object.assign(referee, {suspiciousActivityFlags: 4, hasVerifiedPhone: true});
		const dueAt = await f.refer(REFEREE);
		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('valid');
		expect(await state()).toBe('valid');
		expect(await reason()).toBeNull();
		expect(await f.counts()).toEqual({valid: 1, pending: 0, rejected: 0});
		expect(await checkRows()).toEqual([]);
		expect(referee).toMatchObject({suspiciousActivityFlags: 4, hasVerifiedPhone: true});
		expect(f.jobs).toEqual([
			{
				task: 'grantReferralRewards',
				payload: {user_id: REFERRER.toString()},
				options: {jobKey: `${REFERRER}:1`, skipLedger: true},
			},
		]);
		expect(await evaluate(dueAt, daysAfter(17))).toBe('skipped');
		expect(await f.counts()).toEqual({valid: 1, pending: 0, rejected: 0});
		expect(f.jobs).toHaveLength(1);
	});

	it('account limitation holds the row; the window ends it as risk (rev 2 O5)', async () => {
		f.addUser(REFEREE, {flags: UserFlags.ACCOUNT_LIMITED});
		const dueAt = await f.refer(REFEREE);
		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('retry');
		const [row] = await checkRows();
		expect(await evaluate(row!.due_at, daysAfter(17))).toBe('rejected');
		expect(await reason()).toBe('risk');
	});

	it('a banned referrer: no count while banned, account_gone after the window (rev 2 O1)', async () => {
		f.users.get(REFERRER)!.flags = UserFlags.DISABLED;
		f.users.get(REFERRER)!.tempBannedUntil = daysAfter(400);
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE);

		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('retry');
		expect(await f.counts()).toEqual({valid: 0, pending: 1, rejected: 0});
		const [row] = await checkRows();
		expect(await evaluate(row!.due_at, daysAfter(17))).toBe('rejected');
		expect(await reason()).toBe('account_gone');
		expect(f.jobs).toEqual([]);
	});

	it('a deleted referrer: rejected as account_gone at once, no counters or list rows for the deleted account (V6)', async () => {
		f.users.get(REFERRER)!.flags = UserFlags.DELETED;
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE);

		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('rejected');

		expect(await reason()).toBe('account_gone');
		expect(await checkRows()).toEqual([]);
		expect(await f.counts()).toEqual({valid: 0, pending: 1, rejected: 0});
	});

	it('a referee on a timed ban waits; banned for good is account_gone (CR4, V7)', async () => {
		f.addUser(REFEREE, {flags: UserFlags.DISABLED, tempBannedUntil: daysAfter(10)});
		const dueAt = await f.refer(REFEREE);
		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('retry');
		expect(await state()).toBe('pending');
		const [row] = await checkRows();
		f.users.get(REFEREE)!.flags = 0n;
		expect(await evaluate(row!.due_at, daysAfter(11))).toBe('valid');

		const other = 1490000000000000202n;
		f.addUser(other, {flags: UserFlags.DISABLED, tempBannedUntil: daysAfter(100 * 365)});
		const due2 = await f.refer(other);
		expect(
			await f.service.evaluate(
				createUserID(other),
				{slot: referralCheckSlot(due2), shard: referralCheckShard(other)},
				daysAfter(3.1),
			),
		).toBe('rejected');
		expect((await f.repository.getUserReferral(createUserID(other)))?.reason).toBe('account_gone');
	});

	it('ip_velocity counts registrations up to the referral, never the ones after it (CR5)', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE, {regIp: '203.0.113.9'});
		for (let i = 0; i < 4; i++) {
			f.registrations.push({
				userId: `later-${i}`,
				email: null,
				emailDomain: null,
				ip: '203.0.113.9',
				locale: null,
				createdAt: new Date(REFERRED_AT.getTime() + (i + 1) * 3_600_000),
			});
		}
		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('valid');
	});

	it('reads its check row once, by key (CR8)', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE);
		f.config.min_active_days = 5;
		const getCheck = vi.spyOn(f.repository, 'getCheck');
		const listChecks = vi.spyOn(f.repository, 'listChecks');

		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('moved');

		expect(getCheck).toHaveBeenCalledTimes(1);
		expect(listChecks).not.toHaveBeenCalled();
	});

	it('a row whose evaluation keeps failing moves a day on after 5 attempts (V5)', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE);
		const now = daysAfter(3.1);
		vi.spyOn(f.service.deps.userRepository, 'findUnique').mockRejectedValue(new Error('poison'));

		for (let attempt = 1; attempt < 5; attempt++) {
			await expect(evaluate(dueAt, now)).rejects.toThrow('poison');
			expect((await checkRows())[0]?.due_at).toEqual(dueAt);
		}
		expect(await evaluate(dueAt, now)).toBe('moved');

		const [row] = await checkRows();
		expect(row!.due_at).toEqual(new Date(now.getTime() + DAY_MS));
		expect(await state()).toBe('pending');
	});

	it('daily cap → next day, not rejected; the window never rejects a capped row (rev 2 O8)', async () => {
		f.config.daily_valid_cap = 1;
		const other = 1490000000000000202n;
		f.addUser(REFEREE);
		f.addUser(other);
		const dueAt = await f.refer(REFEREE);
		await f.refer(other);
		const now = daysAfter(3.1);

		expect(await evaluate(dueAt, now)).toBe('valid');
		expect(
			await f.service.evaluate(
				createUserID(other),
				{slot: referralCheckSlot(dueAt), shard: referralCheckShard(other)},
				now,
			),
		).toBe('deferred');
		expect((await f.repository.getUserReferral(createUserID(other)))?.state).toBe('pending');
		// The IP rules already passed: the moved row no longer carries the registration IP (V4).
		const [capped] = await f.repository.listChecks(
			referralCheckSlot(new Date(now.getTime() + DAY_MS)),
			referralCheckShard(other),
			10,
		);
		expect(capped).toMatchObject({referee_id: other, reg_ip: null});

		// Back long after N+14 (a large backlog): still counted, not rejected by the window.
		const late = daysAfter(30);
		const moved = new Date(now.getTime() + DAY_MS);
		expect(
			await f.service.evaluate(
				createUserID(other),
				{slot: referralCheckSlot(moved), shard: referralCheckShard(other)},
				late,
			),
		).toBe('valid');
		expect(await f.counts()).toEqual({valid: 2, pending: 0, rejected: 0});
	});

	it('daily cap: the 3rd valid of a cap-1 day waits 2 days, worked out once', async () => {
		f.config.daily_valid_cap = 1;
		const ids = [REFEREE, 1490000000000000202n, 1490000000000000203n];
		for (const id of ids) {
			f.addUser(id);
			await f.refer(id);
		}
		const now = daysAfter(3.1);
		const dueAt = daysAfter(3);
		const results = [];
		for (const id of ids) {
			results.push(
				await f.service.evaluate(
					createUserID(id),
					{slot: referralCheckSlot(dueAt), shard: referralCheckShard(id)},
					now,
				),
			);
		}
		expect(results).toEqual(['valid', 'deferred', 'deferred']);
		const third = await f.repository.listChecks(
			referralCheckSlot(new Date(now.getTime() + 2 * DAY_MS)),
			referralCheckShard(ids[2]!),
			10,
		);
		expect(third.map((row) => row.referee_id)).toContain(ids[2]);
	});

	it('N raised → row moved to the new day N', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE);
		f.config.min_active_days = 5;

		expect(await evaluate(dueAt, daysAfter(3.1))).toBe('moved');

		const [row] = await checkRows();
		expect(row!.due_at).toEqual(daysAfter(5));
		expect(row!.slot).toBe(referralCheckSlot(daysAfter(5)));
		expect(await state()).toBe('pending');
	});

	it('a row that is not due, gone or already decided does nothing', async () => {
		f.addUser(REFEREE);
		const dueAt = await f.refer(REFEREE);
		expect(await evaluate(dueAt, daysAfter(2.9))).toBe('skipped');
		await evaluate(dueAt, daysAfter(3.1));
		expect(await evaluate(dueAt, daysAfter(3.2))).toBe('skipped');
		expect(await f.counts()).toEqual({valid: 1, pending: 0, rejected: 0});
	});
});
