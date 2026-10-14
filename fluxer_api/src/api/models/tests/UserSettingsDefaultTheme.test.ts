// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {UserSettings} from '@app/api/models/UserSettings';
import {ThemeTypes} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it} from 'vitest';

// Micup: new accounts start on the Coal theme; a theme sent with the registration still wins.
describe('UserSettings.getDefaultUserSettings theme', () => {
	const base = {userId: createUserID(1n), locale: 'en-US', isAdult: true} as const;

	it('defaults new accounts to Coal', () => {
		expect(UserSettings.getDefaultUserSettings(base).theme).toBe(ThemeTypes.COAL);
		expect(UserSettings.getDefaultUserSettings({...base, theme: null}).theme).toBe(ThemeTypes.COAL);
	});

	it('keeps the theme the registration sent', () => {
		expect(UserSettings.getDefaultUserSettings({...base, theme: ThemeTypes.DARK}).theme).toBe(ThemeTypes.DARK);
		expect(UserSettings.getDefaultUserSettings({...base, theme: ThemeTypes.LIGHT}).theme).toBe(ThemeTypes.LIGHT);
	});
});
