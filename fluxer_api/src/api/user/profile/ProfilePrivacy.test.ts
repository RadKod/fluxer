// SPDX-License-Identifier: AGPL-3.0-or-later

import {canHavePublicProfile, resolveProfileAudience} from '@app/api/user/profile/ProfilePrivacy';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

describe('profile privacy levels (sanalyer, Epha 3 Oct)', () => {
	beforeEach(() => vi.useFakeTimers({now: new Date('2026-10-03T12:00:00Z')}));
	afterEach(() => vi.useRealTimers());

	it('reads the stored levels with their new meaning', () => {
		expect(resolveProfileAudience(undefined, '2000-01-01')).toBe('guilds');
		expect(resolveProfileAudience(0, '2000-01-01')).toBe('guilds');
		expect(resolveProfileAudience(1, '2000-01-01')).toBe('guilds');
		expect(resolveProfileAudience(2, '2000-01-01')).toBe('close');
		expect(resolveProfileAudience(100, '2000-01-01')).toBe('everyone');
		expect(resolveProfileAudience(101, '2000-01-01')).toBe('only_me');
		expect(resolveProfileAudience(57, '2000-01-01')).toBe('only_me');
	});

	it('never makes a profile public under 16 or without a date of birth', () => {
		expect(resolveProfileAudience(100, null)).toBe('guilds');
		expect(resolveProfileAudience(100, '2010-10-04')).toBe('guilds'); // 15, a day before 16
		expect(resolveProfileAudience(100, '2010-10-03')).toBe('everyone'); // 16 today
		expect(canHavePublicProfile(undefined)).toBe(false);
	});
});
