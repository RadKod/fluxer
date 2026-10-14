// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {accountPolicyContactHasCapability} from '@app/api/user/LegacyAccountPolicy';
import {afterEach, describe, expect, it} from 'vitest';

const original = Config.risk.accountPolicyDsl;
afterEach(() => {
	Config.risk.accountPolicyDsl = original;
});
const exemptRule = (when: unknown) => ({id: 'exemption', when, capabilities: ['required_actions_exempt']});
function configure(when: unknown, rest: Record<string, unknown> = {}): void {
	Config.risk.accountPolicyDsl = {
		version: 1,
		rules: [],
		sets: {trusted: ['trusted.example']},
		contact_capability_rules: [exemptRule(when)],
		...rest,
	};
}

describe('baseline contact-capability policy validation', () => {
	it.each([
		{rules: [{}]},
		{rules: [{id: 'risk', effects: [{type: 'unknown'}]}]},
		{defaults: {flag_bits: -1}},
		{classifiers: {regional_minimum_age: {by_country: {TR: -1}}}},
	])('rejects malformed non-contact policy sections %#', (rest) => {
		configure({fact: 'contact.domain', in_set: 'trusted'}, rest);
		expect(() => accountPolicyContactHasCapability('a@trusted.example', 'required_actions_exempt')).toThrow();
	});
	it.each([
		{all: []},
		{any: []},
		{fact: 'contact.domain', in_set: 'missing'},
		{fact: 'assessment.score', gt: 1},
		{fact: 'contact.domain', equals: 'trusted.example', not_equals: 'other.example'},
	])('rejects malformed contact conditions %#', (condition) => {
		configure(condition);
		expect(() => accountPolicyContactHasCapability('a@trusted.example', 'required_actions_exempt')).toThrow();
	});
	it('keeps logical-key precedence and original contact values', () => {
		configure({all: [{fact: 'contact.value', equals: '  A@trusted.example  '}], any: [], not: {invalid: true}});
		expect(accountPolicyContactHasCapability('  A@trusted.example  ', 'required_actions_exempt')).toBe(true);
		expect(accountPolicyContactHasCapability('A@trusted.example', 'required_actions_exempt')).toBe(false);
	});
	it('normalizes contact domain and keeps baseline unobserved attributes false', () => {
		configure({
			all: [{fact: 'contact.domain', in_set: 'trusted'}, {not: {fact: 'contact.domain_admin_listed', equals: true}}],
		});
		expect(accountPolicyContactHasCapability('  A@ TRUSTED.EXAMPLE  ', 'required_actions_exempt')).toBe(true);
	});
});
