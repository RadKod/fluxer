// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ProfilePrivacyLevelResponseSchema,
	ProfilePrivacyLevelSchema,
} from '@fluxer/schema/src/primitives/UserSettingsValidators';
import {describe, expect, it} from 'vitest';

describe('profile privacy level schemas (sanalyer A0, T0)', () => {
	it('lets a response carry the four-option values', () => {
		for (const level of [0, 1, 2, 100, 101]) {
			expect(ProfilePrivacyLevelResponseSchema.safeParse(level).success).toBe(true);
		}
	});

	it('accepts the four options and the legacy 1 on a request (1 is kept as written)', () => {
		for (const level of [0, 1, 2, 100, 101]) {
			expect(ProfilePrivacyLevelSchema.safeParse(level).success).toBe(true);
		}
		expect(ProfilePrivacyLevelSchema.safeParse(57).success).toBe(false);
	});
});
