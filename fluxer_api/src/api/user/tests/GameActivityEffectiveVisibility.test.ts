// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import type {UserSettingsRow} from '@app/api/database/types/UserTypes';
import {UserSettings} from '@app/api/models/UserSettings';
import {
	effectiveGameActivityVisibility,
	GAME_ACTIVITY_MIN_AGE,
	gameActivityPolicyState,
	isGameActivityDefaultPending,
	isGameActivityEligible,
} from '@app/api/user/services/GameActivityPolicyService';
import {mapUserSettingsToResponse} from '@app/api/user/UserMappers';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type Stored = UserSettingsRow['game_activity_visibility'];
type Source = UserSettingsRow['game_activity_visibility_source'];

function settings(stored: Stored, source: Source): UserSettings {
	return new UserSettings({
		...UserSettings.getDefaultUserSettings({userId: createUserID(7n), locale: 'en-US', isAdult: true}),
		game_activity_visibility: stored,
		game_activity_visibility_source: source,
	});
}

const human = (dateOfBirth: string | null) => ({isBot: false, isSystem: false, dateOfBirth});

const ELIGIBLE = {
	'15 today': human('2011-10-06'),
	'16': human('2010-01-01'),
	adult: human('2000-01-01'),
};
const INELIGIBLE = {
	'14, 15 tomorrow': human('2011-10-07'),
	'unknown birth date': human(null),
	'invalid birth date': human('2010-02-30'),
	'malformed birth date': human('2010-1-1'),
	bot: {isBot: true, isSystem: false, dateOfBirth: '2000-01-01'},
	system: {isBot: false, isSystem: true, dateOfBirth: '2000-01-01'},
};

const STORED: Array<Stored> = [null, 'off', 'friends', 'everyone'];

function expected(source: Source, stored: Stored): 'off' | 'friends' | 'everyone' {
	if (source === 'default') return stored ?? 'everyone';
	if (source === 'user') return stored ?? 'off';
	return stored === 'friends' ? 'friends' : 'off';
}

beforeEach(() => {
	vi.useFakeTimers({now: new Date('2026-10-06T12:00:00Z'), toFake: ['Date']});
});
afterEach(() => {
	vi.useRealTimers();
});

describe('game activity effective visibility', () => {
	it('legacy_api_off_write_preserves_the_choice_without_changing_the_default_source', () => {
		const initial = settings(null, 'default');
		const legacyWrite = new UserSettings({...initial.toRow(), game_activity_visibility: 'off'});
		expect(legacyWrite.gameActivityVisibilitySource).toBe('default');
		expect(effectiveGameActivityVisibility(ELIGIBLE.adult, legacyWrite)).toBe('off');
	});

	it('null_visibility_survives_a_row_round_trip', () => {
		const value = settings(null, 'default');
		expect(value.gameActivityVisibility).toBeNull();
		expect(value.toRow().game_activity_visibility).toBeNull();
	});

	it('minimum_age_is_fifteen', () => {
		expect(GAME_ACTIVITY_MIN_AGE).toBe(15);
		for (const user of Object.values(ELIGIBLE)) expect(isGameActivityEligible(user)).toBe(true);
		for (const user of Object.values(INELIGIBLE)) expect(isGameActivityEligible(user)).toBe(false);
	});

	for (const source of [null, 'default', 'user'] as const) {
		for (const stored of STORED) {
			it(`eligible_source_${source}_stored_${stored}`, () => {
				for (const user of Object.values(ELIGIBLE)) {
					const value = settings(stored, source);
					expect(effectiveGameActivityVisibility(user, value)).toBe(expected(source, stored));
					expect(gameActivityPolicyState(user, value)).toMatchObject({
						visibility: expected(source, stored),
						eligible_16_plus: true,
					});
				}
			});
			it(`ineligible_source_${source}_stored_${stored}_is_off`, () => {
				for (const user of Object.values(INELIGIBLE)) {
					const value = settings(stored, source);
					expect(effectiveGameActivityVisibility(user, value)).toBe('off');
					expect(gameActivityPolicyState(user, value)).toMatchObject({visibility: 'off', eligible_16_plus: false});
				}
			});
		}
	}

	it('missing_account_or_settings_is_off', () => {
		expect(effectiveGameActivityVisibility(null, settings(null, 'default'))).toBe('off');
		expect(effectiveGameActivityVisibility(ELIGIBLE.adult, null)).toBe('off');
		expect(isGameActivityDefaultPending(null, settings(null, null))).toBe(false);
	});

	it('default_pending_only_for_eligible_accounts_without_a_source', () => {
		for (const stored of STORED) {
			expect(isGameActivityDefaultPending(ELIGIBLE['15 today'], settings(stored, null))).toBe(true);
			expect(isGameActivityDefaultPending(ELIGIBLE.adult, settings(stored, 'default'))).toBe(false);
			expect(isGameActivityDefaultPending(ELIGIBLE.adult, settings(stored, 'user'))).toBe(false);
			for (const user of Object.values(INELIGIBLE))
				expect(isGameActivityDefaultPending(user, settings(stored, null))).toBe(false);
		}
	});

	it('row_round_trip_keeps_everyone_and_source', () => {
		const value = settings('everyone', 'user');
		expect(value.gameActivityVisibility).toBe('everyone');
		expect(value.gameActivityVisibilitySource).toBe('user');
		expect(value.toRow()).toMatchObject({
			game_activity_visibility: 'everyone',
			game_activity_visibility_source: 'user',
		});
		const unknown = settings('public' as never, 'admin' as never);
		expect(unknown.gameActivityVisibility).toBe('off');
		expect(unknown.gameActivityVisibilitySource).toBeNull();
	});

	it('settings_response_carries_effective_eligible_and_pending', () => {
		expect(mapUserSettingsToResponse({settings: settings('off', null), user: ELIGIBLE.adult})).toMatchObject({
			game_activity_visibility: 'off',
			game_activity_eligible: true,
			game_activity_default_pending: true,
		});
		expect(mapUserSettingsToResponse({settings: settings(null, 'default'), user: ELIGIBLE['15 today']})).toMatchObject({
			game_activity_visibility: 'everyone',
			game_activity_eligible: true,
			game_activity_default_pending: false,
		});
		expect(
			mapUserSettingsToResponse({settings: settings('friends', 'user'), user: INELIGIBLE['14, 15 tomorrow']}),
		).toMatchObject({
			game_activity_visibility: 'off',
			game_activity_eligible: false,
			game_activity_default_pending: false,
		});
		expect(mapUserSettingsToResponse({settings: settings('everyone', 'user'), user: null})).toMatchObject({
			game_activity_visibility: 'off',
			game_activity_eligible: false,
			game_activity_default_pending: false,
		});
	});
});
