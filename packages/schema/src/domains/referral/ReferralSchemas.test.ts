// SPDX-License-Identifier: AGPL-3.0-or-later

import {RegisterRequest} from '@fluxer/schema/src/domains/auth/AuthSchemas';
import {
	isReferralCodeShape,
	REFERRAL_CODE_ALPHABET,
	REFERRAL_CODE_LENGTH,
} from '@fluxer/schema/src/domains/referral/ReferralCode';
import {
	CreateReferralTierRequest,
	DeliverReferralRewardRequest,
	ListReferralPendingRewardsQuery,
	ReferralTierReward,
	UpdateReferralTierRequest,
} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import {
	AdminUserReferralsResponse,
	ReferralMeResponse,
} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';
import {describe, expect, it} from 'vitest';

describe('referral schemas', () => {
	it('one referral code shape for server and client: 10 base32 characters', () => {
		expect(REFERRAL_CODE_ALPHABET).toBe('abcdefghijklmnopqrstuvwxyz234567');
		expect(REFERRAL_CODE_LENGTH).toBe(10);
		expect(isReferralCodeShape('abcdef2345')).toBe(true);
		for (const bad of ['', 'abcdef234', 'abcdef23456', 'ABCDEF2345', 'abcdef2341', 'abcdef23!5']) {
			expect(isReferralCodeShape(bad)).toBe(false);
		}
	});

	it('tier reward union rejects unknown type', () => {
		expect(ReferralTierReward.safeParse({type: 'cosmetic', item_id: '1490000000000000001'}).success).toBe(true);
		expect(ReferralTierReward.safeParse({type: 'premium_days', days: 30}).success).toBe(true);
		expect(ReferralTierReward.safeParse({type: 'offsite', description: 'Steam key'}).success).toBe(true);
		expect(ReferralTierReward.safeParse({type: 'money', amount: 5}).success).toBe(false);
		expect(ReferralTierReward.safeParse({type: 'premium_days', days: 0}).success).toBe(false);
		expect(ReferralTierReward.safeParse({type: 'premium_days', days: 3651}).success).toBe(false);
		expect(ReferralTierReward.safeParse({type: 'offsite', description: ''}).success).toBe(false);
	});

	it('threshold bounds 1..1_000_000', () => {
		const reward = {type: 'premium_days', days: 7};
		expect(CreateReferralTierRequest.safeParse({threshold: 0, reward}).success).toBe(false);
		expect(CreateReferralTierRequest.safeParse({threshold: 1_000_001, reward}).success).toBe(false);
		expect(CreateReferralTierRequest.parse({threshold: 1_000_000, reward})).toEqual({
			threshold: 1_000_000,
			reward,
			enabled: true,
		});
		expect(UpdateReferralTierRequest.safeParse({}).success).toBe(false);
		expect(UpdateReferralTierRequest.safeParse({enabled: false}).success).toBe(true);
		expect(UpdateReferralTierRequest.safeParse({reward}).success).toBe(false);
	});

	it('deliver code ≤256', () => {
		expect(DeliverReferralRewardRequest.safeParse({code: 'x'.repeat(256)}).success).toBe(true);
		expect(DeliverReferralRewardRequest.safeParse({code: 'x'.repeat(257)}).success).toBe(false);
		expect(DeliverReferralRewardRequest.safeParse({code: null, note: null}).success).toBe(true);
	});

	it('pending rewards month is YYYY-MM and limit defaults to 50', () => {
		expect(ListReferralPendingRewardsQuery.parse({})).toEqual({limit: 50});
		expect(ListReferralPendingRewardsQuery.safeParse({month: '2026-10'}).success).toBe(true);
		expect(ListReferralPendingRewardsQuery.safeParse({month: '2026-1'}).success).toBe(false);
		expect(ListReferralPendingRewardsQuery.safeParse({limit: '101'}).success).toBe(false);
	});

	it('RegisterRequest accepts any ≤64 referral_code and ignores a longer one', () => {
		for (const referral_code of ['abcdefghij', 'NOT A CODE!', 'x'.repeat(64)]) {
			expect(RegisterRequest.parse({referral_code}).referral_code).toBe(referral_code);
		}
		for (const referral_code of ['x'.repeat(65), 'x'.repeat(100_000), '', null]) {
			expect(RegisterRequest.parse({referral_code}).referral_code).toBeNull();
		}
		expect(RegisterRequest.parse({}).referral_code).toBeUndefined();
	});

	it('ReferralMeResponse has no ip field', () => {
		const keys = (schema: {shape: Record<string, unknown>}) => Object.keys(schema.shape).join(',');
		expect(keys(ReferralMeResponse)).not.toMatch(/ip/);
		expect(keys(AdminUserReferralsResponse)).not.toMatch(/ip/);
		const referee = AdminUserReferralsResponse.shape.referees.element;
		expect(Object.keys(referee.shape)).not.toContain('reg_ip');
		const reward = AdminUserReferralsResponse.shape.rewards.element;
		expect(Object.keys(reward.shape)).not.toContain('code');
		expect(Object.keys(reward.shape)).toContain('has_code');
	});
});
