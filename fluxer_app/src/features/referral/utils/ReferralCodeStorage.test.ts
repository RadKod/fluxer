// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	clearReferralCode,
	REFERRAL_CODE_TTL_MS,
	readReferralCode,
	saveReferralCode,
} from '@app/features/referral/utils/ReferralCodeStorage';
import {afterEach, describe, expect, it} from 'vitest';

const NOW = 1_800_000_000_000;

describe('ReferralCodeStorage', () => {
	afterEach(() => clearReferralCode());

	it('stores lowercase valid code', () => {
		expect(saveReferralCode('ABCDEF2345', NOW)).toBe(true);
		expect(readReferralCode(NOW)).toBe('abcdef2345');
	});

	it('ignores malformed', () => {
		for (const bad of ['', 'short', 'abcdef23456', 'abcdef2341', 'abcdef23!5', '../etc/pw']) {
			expect(saveReferralCode(bad, NOW)).toBe(false);
		}
		expect(readReferralCode(NOW)).toBeNull();
	});

	it('keeps an earlier code when a malformed one follows', () => {
		saveReferralCode('abcdef2345', NOW);
		saveReferralCode('nope', NOW);
		expect(readReferralCode(NOW)).toBe('abcdef2345');
	});

	it('expires after 30 days', () => {
		saveReferralCode('abcdef2345', NOW);
		expect(readReferralCode(NOW + REFERRAL_CODE_TTL_MS - 1)).toBe('abcdef2345');
		expect(readReferralCode(NOW + REFERRAL_CODE_TTL_MS)).toBeNull();
		expect(readReferralCode(NOW)).toBeNull();
	});

	it('clear', () => {
		saveReferralCode('abcdef2345', NOW);
		clearReferralCode();
		expect(readReferralCode(NOW)).toBeNull();
	});
});
