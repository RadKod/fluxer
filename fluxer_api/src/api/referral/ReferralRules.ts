// SPDX-License-Identifier: AGPL-3.0-or-later

import {REFERRAL_DECISION_WINDOW_DAYS} from '@app/api/database/types/ReferralTypes';
import type {ReferralTierConfig} from '@app/api/instance/InstanceConfigRepository';
import type {User} from '@app/api/models/User';
import {derivePlusAddressBase} from '@app/api/risk/PlusAddressUtils';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {DAYS_PER_YEAR, MS_PER_DAY} from '@fluxer/date_utils/src/DateConstants';
import {getSameIpDecisionKey} from '@fluxer/ip_utils/src/IpAddress';
import type {ReferralRejectReason} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';

// AdminUserBanService: a permanent ban is DISABLED with a ban end a century ahead; a timed one stays well under a year.
const PERMANENT_BAN_MS = DAYS_PER_YEAR * MS_PER_DAY;

export interface ReferralFacts {
	now: Date;
	referredAt: Date;
	minActiveDays: number;
	refereeGone: boolean; // deleted, being deleted, a spammer or banned for good
	refereeBanned: boolean; // on a timed ban right now: waits
	referrerDeleted: boolean;
	referrerAvailable: boolean; // not gone and not banned right now
	riskBlocked: boolean;
	sameIp: boolean; // the referee's registration or last IP is one of the referrer's authorized IPs
	ipRegistrations: number; // registrations in 30 days under the referee's registration IP key
	ipRegistrationLimit: number;
	sameEmail: boolean;
	pendingApproval: boolean;
	suspicious: boolean;
	emailVerified: boolean;
	lastActiveAt: Date | null;
}

export type ReferralDecision =
	| {kind: 'valid'}
	| {kind: 'rejected'; reason: ReferralRejectReason}
	| {kind: 'retry'; at: Date};

// Outright rejections first; then the waits, each retried daily until the window ends with its own reason.
export function decideReferral(f: ReferralFacts): ReferralDecision {
	if (f.refereeGone || f.referrerDeleted) return {kind: 'rejected', reason: 'account_gone'};
	if (f.riskBlocked) return {kind: 'rejected', reason: 'risk'};
	if (f.sameIp) return {kind: 'rejected', reason: 'same_ip'};
	if (f.ipRegistrations > f.ipRegistrationLimit) return {kind: 'rejected', reason: 'ip_velocity'};
	if (f.sameEmail) return {kind: 'rejected', reason: 'same_email'};
	const activeFrom = f.referredAt.getTime() + f.minActiveDays * MS_PER_DAY;
	const waiting: ReferralRejectReason | null =
		!f.referrerAvailable || f.refereeBanned
			? 'account_gone'
			: f.pendingApproval
				? 'inactive'
				: f.suspicious
					? 'risk'
					: !f.emailVerified
						? 'unverified'
						: (f.lastActiveAt?.getTime() ?? 0) < activeFrom
							? 'inactive'
							: null;
	if (waiting === null) return {kind: 'valid'};
	if (f.now.getTime() >= activeFrom + REFERRAL_DECISION_WINDOW_DAYS * MS_PER_DAY) {
		return {kind: 'rejected', reason: waiting};
	}
	return {kind: 'retry', at: new Date(f.now.getTime() + MS_PER_DAY)};
}

// Deleted, being deleted, a spammer or banned for good: never coming back. A timed ban is not (CR4).
export function isReferralAccountGone(user: User | null, now: Date): boolean {
	if (!user) return true;
	if ((user.flags & (UserFlags.DELETED | UserFlags.SELF_DELETED | UserFlags.SPAMMER)) !== 0n) return true;
	if (user.deletionStartedAt || user.pendingDeletionAt) return true;
	return isBannedPast(user, now.getTime() + PERMANENT_BAN_MS);
}

// Under a ban right now. A lapsed timed ban counts as live.
export function isReferralAccountBanned(user: User | null, now: Date): boolean {
	return !!user && isBannedPast(user, now.getTime());
}

function isBannedPast(user: User, at: number): boolean {
	return (user.flags & UserFlags.DISABLED) !== 0n && (user.tempBannedUntil?.getTime() ?? 0) > at;
}

// Enabled tiers the count reaches and the account has no reward row for, lowest threshold first.
export function dueTiers(
	tiers: ReadonlyArray<ReferralTierConfig>,
	validCount: number,
	rewards: ReadonlyArray<{tier_id: bigint}>,
): Array<ReferralTierConfig> {
	const have = new Set(rewards.map((row) => row.tier_id.toString()));
	return tiers
		.filter((tier) => tier.enabled && tier.threshold <= validCount && !have.has(tier.id))
		.sort((a, b) => a.threshold - b.threshold);
}

// Days a valid referral waits when it is the `sequence`-th of its referrer today: 0 within the cap, else the day its
// place in the queue falls on, worked out once.
export function capDeferDays(sequence: number, cap: number): number {
	return Math.ceil(sequence / cap) - 1;
}

// The same-IP key Fluxer's registration limit uses: the exact IPv4 address, the IPv6 /64.
export function referralIpKey(ip: string): string {
	return getSameIpDecisionKey(ip) ?? ip;
}

export function sameEmailBase(a: string | null, b: string | null): boolean {
	if (!a || !b) return false;
	const base = (email: string) => derivePlusAddressBase(email) ?? email.trim().toLowerCase();
	return base(a) === base(b);
}
