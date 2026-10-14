// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	isUsernameGateEscapePath,
	isUsernameSelectionRequired,
	nextUsernamePromptDay,
	type UsernameGateMigration,
	type UsernameGateUser,
	usernameGateMode,
	usernamePromptDay,
} from '@app/features/user/utils/UsernameSelectionGateUtils';
import {describe, expect, test} from 'vitest';

const started = Date.parse('2026-10-01T00:00:00Z');
const forced = started + 7 * 24 * 60 * 60 * 1000;
const migration: UsernameGateMigration = {
	state: 'selecting',
	epoch: 1,
	started_at: new Date(started).toISOString(),
	forced_at: new Date(forced).toISOString(),
};
const user: UsernameGateUser = {id: '1234567890123456', usernameState: 'legacy', bot: false, system: false};

describe('username root gate decisions', () => {
	test('prompts only unselected humans during selecting', () => {
		expect(usernameGateMode(user, migration, started)).toBe('prompt');
		expect(usernameGateMode({...user, usernameState: 'selected'}, migration, started)).toBe('none');
		for (const state of ['legacy', 'preparing'] as const) {
			expect(usernameGateMode(user, {...migration, state}, forced)).toBe('none');
		}
	});
	test('derives forced at the exact deadline', () => {
		expect(usernameGateMode(user, migration, forced - 1)).toBe('prompt');
		expect(usernameGateMode(user, migration, forced)).toBe('required');
	});
	test('moderation and the server error require selection immediately', () => {
		expect(
			usernameGateMode({...user, usernameState: 'reselect_required'}, {...migration, state: 'legacy'}, started),
		).toBe('required');
		expect(usernameGateMode(user, migration, started, true)).toBe('required');
		expect(usernameGateMode({...user, usernameState: 'selected'}, migration, started, true)).toBe('required');
	});
	test('exempts absent, bot, system, suspended and deleted accounts even after an error', () => {
		expect(usernameGateMode(undefined, migration, forced, true)).toBe('none');
		for (const exemption of ['bot', 'system', 'suspended', 'deleted']) {
			expect(usernameGateMode({...user, [exemption]: true}, migration, forced, true)).toBe('none');
		}
	});
	test('uses the server Europe/Istanbul day and schedules its next midnight', () => {
		const now = Date.parse('2026-10-01T21:00:00Z');
		expect(usernamePromptDay(now - 1)).toBe('2026-10-01');
		expect(usernamePromptDay(now)).toBe('2026-10-02');
		expect(nextUsernamePromptDay(now)).toBe(Date.parse('2026-10-02T21:00:00Z'));
	});
	test.each([
		'/login',
		'/verify',
		'/verify/token',
		'/forgot',
		'/reset',
		'/recover',
		'/wasntme',
		'/authorize-ip',
		'/report',
		'/age-verification-callback',
	])('leaves the exact escape route %s accessible', (path) => {
		expect(isUsernameGateEscapePath(path)).toBe(true);
	});
	test.each(['/login-evil', '/channels/@me', '/oauth2/authorize', '/feed'])(
		'does not exempt unrelated route %s',
		(path) => {
			expect(isUsernameGateEscapePath(path)).toBe(false);
		},
	);
	test('recognizes HTTP and gateway username errors without swallowing unrelated errors', () => {
		expect(isUsernameSelectionRequired({code: 'USERNAME_SELECTION_REQUIRED'})).toBe(true);
		expect(isUsernameSelectionRequired({body: {code: 'USERNAME_SELECTION_REQUIRED'}})).toBe(true);
		expect(isUsernameSelectionRequired({code: 'VOICE_PERMISSION_DENIED'})).toBe(false);
		expect(isUsernameSelectionRequired(null)).toBe(false);
	});
});
