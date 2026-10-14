// SPDX-License-Identifier: AGPL-3.0-or-later

import {REFERRAL_DECISION_WINDOW_DAYS, referralBand} from '@app/api/database/types/ReferralTypes';
import type {ReferralTierConfig} from '@app/api/instance/InstanceConfigRepository';
import type {User} from '@app/api/models/User';
import {
	capDeferDays,
	decideReferral,
	dueTiers,
	isReferralAccountBanned,
	isReferralAccountGone,
	type ReferralFacts,
	referralIpKey,
	sameEmailBase,
} from '@app/api/referral/ReferralRules';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it} from 'vitest';

const DAY = 86_400_000;
const REFERRED_AT = new Date('2026-10-01T10:00:00.000Z');
const at = (days: number) => new Date(REFERRED_AT.getTime() + days * DAY);

function facts(patch: Partial<ReferralFacts> = {}): ReferralFacts {
	return {
		now: at(3),
		referredAt: REFERRED_AT,
		minActiveDays: 3,
		refereeGone: false,
		refereeBanned: false,
		referrerDeleted: false,
		referrerAvailable: true,
		riskBlocked: false,
		sameIp: false,
		ipRegistrations: 1,
		ipRegistrationLimit: 3,
		sameEmail: false,
		pendingApproval: false,
		suspicious: false,
		emailVerified: true,
		lastActiveAt: at(3),
		...patch,
	};
}

function tier(id: string, threshold: number, enabled = true): ReferralTierConfig {
	return {id, threshold, enabled, reward: {type: 'premium_days', days: 7}, created_at: REFERRED_AT.toISOString()};
}

function user(patch: Partial<User> = {}): User {
	return {
		flags: 0n,
		tempBannedUntil: null,
		deletionStartedAt: null,
		pendingDeletionAt: null,
		...patch,
	} as unknown as User;
}

describe('ReferralRules', () => {
	it('band of 1,2,3,4,1023,1024', () => {
		expect([1, 2, 3, 4, 1023, 1024].map(referralBand)).toEqual([0, 1, 1, 2, 9, 10]);
	});

	it('dueTiers picks enabled ≤count not granted', () => {
		const tiers = [tier('30', 10), tier('10', 1), tier('20', 5, false), tier('40', 3), tier('50', 4)];
		const rewards = [{tier_id: 50n}];
		expect(dueTiers(tiers, 4, rewards).map((t) => t.id)).toEqual(['10', '40']);
		expect(dueTiers(tiers, 0, [])).toEqual([]);
	});

	it('verified, active on day N and clean → valid', () => {
		expect(decideReferral(facts())).toEqual({kind: 'valid'});
	});

	it.each([
		['refereeGone', {refereeGone: true}, 'account_gone'],
		['referrer deleted', {referrerDeleted: true, referrerAvailable: false}, 'account_gone'],
		['risk_blocked', {riskBlocked: true}, 'risk'],
		['same_ip', {sameIp: true}, 'same_ip'],
		['ip_velocity', {ipRegistrations: 4}, 'ip_velocity'],
		['same_email', {sameEmail: true}, 'same_email'],
	] as const)('%s → rejected at once', (_name, patch, reason) => {
		expect(decideReferral(facts(patch))).toEqual({kind: 'rejected', reason});
	});

	it('the IP limit counts more than K registrations, not K', () => {
		expect(decideReferral(facts({ipRegistrations: 3}))).toEqual({kind: 'valid'});
	});

	it.each([
		['unverified', {emailVerified: false}, 'unverified'],
		['inactive', {lastActiveAt: at(2.9)}, 'inactive'],
		['never active', {lastActiveAt: null}, 'inactive'],
		['pending approval', {pendingApproval: true}, 'inactive'],
		['suspicious', {suspicious: true}, 'risk'],
		['referrer unavailable', {referrerAvailable: false}, 'account_gone'],
		['referee on a timed ban', {refereeBanned: true}, 'account_gone'],
	] as const)('%s → rescheduled a day later, rejected once the N+14 day window ends', (_name, patch, reason) => {
		expect(decideReferral(facts({...patch, now: at(5)}))).toEqual({kind: 'retry', at: at(6)});
		expect(decideReferral(facts({...patch, now: at(3 + 14 - 0.01)}))).toEqual({kind: 'retry', at: at(4 + 14 - 0.01)});
		expect(decideReferral(facts({...patch, now: at(3 + 14)}))).toEqual({kind: 'rejected', reason});
	});

	it('the decision window is the one the check row TTL is built from', () => {
		const waiting = {emailVerified: false};
		expect(decideReferral(facts({...waiting, now: at(3 + REFERRAL_DECISION_WINDOW_DAYS - 0.01)})).kind).toBe('retry');
		expect(decideReferral(facts({...waiting, now: at(3 + REFERRAL_DECISION_WINDOW_DAYS)})).kind).toBe('rejected');
	});

	it('an outright rejection wins over a wait', () => {
		expect(decideReferral(facts({sameIp: true, emailVerified: false}))).toEqual({kind: 'rejected', reason: 'same_ip'});
	});

	it('daily cap: the target day is ceil(sequence / cap) days out, counted once', () => {
		expect(capDeferDays(1, 50)).toBe(0);
		expect(capDeferDays(50, 50)).toBe(0);
		expect(capDeferDays(51, 50)).toBe(1);
		expect(capDeferDays(100, 50)).toBe(1);
		expect(capDeferDays(101, 50)).toBe(2);
	});

	it('same e-mail compares plus-address bases, case-insensitively', () => {
		expect(sameEmailBase('Ali+x@Mail.com', 'ali@mail.com')).toBe(true);
		expect(sameEmailBase('ali+a@mail.com', 'ali+b@mail.com')).toBe(true);
		expect(sameEmailBase('ali@mail.com', 'veli@mail.com')).toBe(false);
		expect(sameEmailBase(null, 'ali@mail.com')).toBe(false);
		expect(sameEmailBase(null, null)).toBe(false);
	});

	it('IP key: exact IPv4, /64 for IPv6', () => {
		expect(referralIpKey('203.0.113.7')).toBe(referralIpKey('203.0.113.7'));
		expect(referralIpKey('203.0.113.7')).not.toBe(referralIpKey('203.0.113.8'));
		expect(referralIpKey('2001:db8:1:2::1')).toBe(referralIpKey('2001:db8:1:2:ffff::9'));
		expect(referralIpKey('2001:db8:1:2::1')).not.toBe(referralIpKey('2001:db8:1:3::1'));
	});

	it('account gone for good: missing, deleted, spammer, being deleted or banned for good; a timed ban is not', () => {
		const now = at(0);
		const century = new Date(now.getTime() + 100 * 365 * DAY);
		expect(isReferralAccountGone(null, now)).toBe(true);
		expect(isReferralAccountGone(user(), now)).toBe(false);
		expect(isReferralAccountGone(user({flags: UserFlags.DELETED}), now)).toBe(true);
		expect(isReferralAccountGone(user({flags: UserFlags.SELF_DELETED}), now)).toBe(true);
		expect(isReferralAccountGone(user({flags: UserFlags.SPAMMER}), now)).toBe(true);
		expect(isReferralAccountGone(user({pendingDeletionAt: now}), now)).toBe(true);
		expect(isReferralAccountGone(user({deletionStartedAt: now}), now)).toBe(true);
		expect(isReferralAccountGone(user({flags: UserFlags.DISABLED, tempBannedUntil: century}), now)).toBe(true);
		expect(isReferralAccountGone(user({flags: UserFlags.DISABLED, tempBannedUntil: at(1)}), now)).toBe(false);
		expect(isReferralAccountGone(user({flags: UserFlags.DISABLED, tempBannedUntil: at(-1)}), now)).toBe(false);
	});

	it('banned now: any live ban; a lapsed one is not', () => {
		const now = at(0);
		expect(isReferralAccountBanned(user({flags: UserFlags.DISABLED, tempBannedUntil: at(1)}), now)).toBe(true);
		expect(isReferralAccountBanned(user({flags: UserFlags.DISABLED, tempBannedUntil: at(-1)}), now)).toBe(false);
		expect(isReferralAccountBanned(user(), now)).toBe(false);
		expect(isReferralAccountBanned(null, now)).toBe(false);
	});
});
