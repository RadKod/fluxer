// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';
import {isLegacyAccountRestricted} from '@app/api/user/AccountLimit';
import {
	getCachedDeferredPhoneGateEnabled,
	setCachedDeferredPhoneGateEnabled,
} from '@app/api/user/DeferredPhoneGateCache';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

function user(flags: number, overrides: Partial<UserRow> = {}): User {
	return new User({
		...EMPTY_USER_ROW,
		user_id: createUserID(123n),
		email: 'legacy@example.com',
		email_verified: false,
		has_verified_phone: false,
		suspicious_activity_flags: flags,
		...overrides,
	});
}

describe('baseline legacy required actions', () => {
	const originalPolicy = Config.risk.accountPolicyDsl;
	const originalPhoneFlagging = Config.abusePolicy.phoneFlagging.enabled;
	let originalGate: boolean | null;
	beforeEach(() => {
		originalGate = getCachedDeferredPhoneGateEnabled();
		setCachedDeferredPhoneGateEnabled(true);
	});
	afterEach(() => {
		Config.risk.accountPolicyDsl = originalPolicy;
		Config.abusePolicy.phoneFlagging.enabled = originalPhoneFlagging;
		if (originalGate !== null) setCachedDeferredPhoneGateEnabled(originalGate);
	});
	it('preserves configured required-actions domain exemptions', () => {
		Config.risk.accountPolicyDsl = {
			version: 1,
			sets: {exempt: ['trusted.example']},
			rules: [],
			contact_capability_rules: [
				{
					id: 'legacy_exempt',
					when: {fact: 'contact.domain', in_set: 'exempt'},
					capabilities: ['required_actions_exempt'],
				},
			],
		};
		expect(isLegacyAccountRestricted(user(8, {email: 'Person@TRUSTED.EXAMPLE'}))).toBe(false);
		expect(isLegacyAccountRestricted(user(8, {email: 'other@example.com'}))).toBe(true);
	});
	it.each([
		[1, {email_verified: true}],
		[4, {has_verified_phone: true}],
		[16, {email_verified: true}],
		[16, {has_verified_phone: true}],
		[32, {has_verified_phone: true}],
		[64, {email_verified: true}],
		[256, {has_verified_phone: true}],
		[(1 << 16) | 4, {}],
		[(1 << 16) | 8, {}],
		[1 << 16, {}],
		[1 << 17, {}],
		[1 << 20, {}],
		[4, {email: null}],
	] satisfies Array<[number, Partial<UserRow>]>)(
		'permits a satisfied or deferred requirement %s case %#',
		(flags, overrides) => {
			expect(isLegacyAccountRestricted(user(flags, overrides))).toBe(false);
		},
	);
	it.each([1, 2, 4, 8, 16, 32, 64, 128, 256])('blocks an outstanding requirement %s', (flags) => {
		expect(isLegacyAccountRestricted(user(flags))).toBe(true);
	});
	it.each([2, 8, 128])('keeps reverification %s outstanding after prior verification', (flags) => {
		expect(isLegacyAccountRestricted(user(flags, {email_verified: true, has_verified_phone: true}))).toBe(true);
	});
	it('only activates deferred phone requirements when the gate is disabled and phone flagging is enabled', () => {
		setCachedDeferredPhoneGateEnabled(false);
		Config.abusePolicy.phoneFlagging.enabled = true;
		expect(isLegacyAccountRestricted(user((1 << 16) | 4))).toBe(true);
		Config.abusePolicy.phoneFlagging.enabled = false;
		expect(isLegacyAccountRestricted(user((1 << 16) | 4))).toBe(false);
	});
	it('keeps inbound verification outstanding alongside a deferred phone requirement', () => {
		expect(isLegacyAccountRestricted(user((1 << 16) | 4 | 256))).toBe(true);
	});
});
