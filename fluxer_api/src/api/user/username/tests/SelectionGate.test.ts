// SPDX-License-Identifier: AGPL-3.0-or-later

import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {describe, expect, it} from 'vitest';

const load = () => import('../UsernameSelectionGate').catch(() => null);
const actions = [
	'message',
	'reaction',
	'guild_join',
	'bot_add',
	'guild_create',
	'dm_open',
	'group_dm',
	'relationship_create',
	'voice_join',
] as const;
const now = 1000;
function fixture(extra: Partial<UserRow> = {}) {
	const row = {...EMPTY_USER_ROW, ...extra};
	return {user: new User(row), readUsernameState: () => row.username_state ?? null};
}

describe('username selection gate', () => {
	it('requires reselection without reading the global migration configuration', async () => {
		const mod = await load();
		expect(mod).not.toBeNull();
		const reselect = fixture({username_state: 'reselect_required'});
		const gate = new mod!.UsernameSelectionGate(
			() => {
				throw new Error('Configuration unavailable');
			},
			reselect.readUsernameState,
			() => now,
		);
		expect(() => gate.assertMayAct(reselect.user, 'message')).toThrowError(
			expect.objectContaining({code: 'USERNAME_SELECTION_REQUIRED', status: 403}),
		);
	});
	it.each(actions)('gates initiating humans for %s at the forced deadline', async (action) => {
		const mod = await load();
		expect(mod).not.toBeNull();
		const pending = fixture();
		const gate = new mod!.UsernameSelectionGate(
			() => ({state: 'selecting', forcedAt: new Date(now)}),
			pending.readUsernameState,
			() => now,
		);
		expect(() => gate.assertMayAct(pending.user, action)).toThrowError(
			expect.objectContaining({code: 'USERNAME_SELECTION_REQUIRED', status: 403}),
		);
		const selected = fixture({username_state: 'selected'});
		const selectedGate = new mod!.UsernameSelectionGate(
			() => ({state: 'selecting', forcedAt: new Date(now)}),
			selected.readUsernameState,
			() => now,
		);
		expect(() => selectedGate.assertMayAct(selected.user, action)).not.toThrow();
	});
	it.each(['legacy', 'preparing', 'selecting'] as const)('requires reselection immediately in %s', async (state) => {
		const mod = await load();
		expect(mod).not.toBeNull();
		const reselect = fixture({username_state: 'reselect_required'});
		const gate = new mod!.UsernameSelectionGate(
			() => ({state, forcedAt: state === 'selecting' ? new Date(9000) : null}),
			reselect.readUsernameState,
			() => now,
		);
		expect(() => gate.assertMayAct(reselect.user, 'message')).toThrowError(
			expect.objectContaining({code: 'USERNAME_SELECTION_REQUIRED'}),
		);
	});
	it.each([
		{bot: true},
		{system: true},
		{flags: UserFlags.DELETED},
		{flags: UserFlags.DISABLED},
		{flags: UserFlags.DISABLED, temp_banned_until: new Date(2000)},
	])('exempts bot, system, deleted or currently suspended accounts', async (extra) => {
		const mod = await load();
		expect(mod).not.toBeNull();
		const exempt = fixture({username_state: 'reselect_required', ...extra});
		const gate = new mod!.UsernameSelectionGate(
			() => ({state: 'selecting', forcedAt: new Date(now)}),
			exempt.readUsernameState,
			() => now,
		);
		expect(() => gate.assertMayAct(exempt.user, 'message')).not.toThrow();
	});
	it('does not exempt an expired suspension and does not gate the voluntary period', async () => {
		const mod = await load();
		expect(mod).not.toBeNull();
		const expired = fixture({flags: UserFlags.DISABLED, temp_banned_until: new Date(999)});
		const gate = new mod!.UsernameSelectionGate(
			() => ({state: 'selecting', forcedAt: new Date(now)}),
			expired.readUsernameState,
			() => now,
		);
		expect(() => gate.assertMayAct(expired.user, 'voice_join')).toThrow();
		const voluntary = new mod!.UsernameSelectionGate(
			() => ({state: 'selecting', forcedAt: new Date(now + 1)}),
			expired.readUsernameState,
			() => now,
		);
		expect(() => voluntary.assertMayAct(expired.user, 'voice_join')).not.toThrow();
	});
});
