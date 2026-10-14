// SPDX-License-Identifier: AGPL-3.0-or-later

import {formatUserTag, parseUserTagInput, shouldShowDiscriminator} from '@app/features/user/utils/UserTagUtils';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/app/state/RuntimeConfig', () => ({default: {usesUniqueUsernames: true}}));

describe('migration user tags', () => {
	it('shows selected human identities with an at sign independently of instance tag style', () => {
		expect(formatUserTag({username: 'ayse', discriminator: '0000'}, false)).toBe('@ayse');
	});
	it('keeps unselected identities and bots tagged when instance tags are hidden', () => {
		expect(formatUserTag({username: 'Ayse', discriminator: '1234'})).toBe('Ayse#1234');
		expect(formatUserTag({username: 'bot', discriminator: '0000', bot: true})).toBe('bot#0000');
		expect(shouldShowDiscriminator({discriminator: '1234'})).toBe(true);
	});
	it('keeps system accounts outside the selected human identity format', () => {
		expect(formatUserTag({username: 'system', discriminator: '0000', system: true})).toBe('system#0000');
	});
	it('accepts bare or at-prefixed selected names and preserves legacy tags', () => {
		expect(parseUserTagInput(' @ayse ')).toEqual(['ayse']);
		expect(parseUserTagInput('ayse')).toEqual(['ayse']);
		expect(parseUserTagInput('Ayse#1234')).toEqual(['Ayse', '1234']);
	});
	it('does not reinterpret explicit zero tags or malformed tags as selected names', () => {
		for (const input of ['ayse#0000', 'ayse#0', 'ayse#1234#5678', '@', 'ayse#abc']) {
			expect(parseUserTagInput(input)).toBeNull();
		}
	});
});
