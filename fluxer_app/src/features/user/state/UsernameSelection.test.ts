// SPDX-License-Identifier: AGPL-3.0-or-later

import {UsernameSelectionState} from '@app/features/user/state/UsernameSelection';
import {describe, expect, test} from 'vitest';

describe('account-scoped username screen', () => {
	test('a newer selected USER_UPDATE from another session clears an error, while an older identity does not', () => {
		const state = new UsernameSelectionState();
		state.bindAccount('instance::user1');
		state.requireSelection('instance::user1', '4');
		expect('observeIdentity' in state).toBe(true);
		state.observeIdentity('instance::user1', 'selected', '3');
		expect(state.requiredAccountKey).toBe('instance::user1');
		state.observeIdentity('instance::user1', 'selected', '4');
		expect(state.requiredAccountKey).toBe('instance::user1');
		state.observeIdentity('instance::user1', 'selected', '5');
		expect(state.requiredAccountKey).toBeNull();
	});
	test('a server error opens the same required screen for the active account', () => {
		const state = new UsernameSelectionState();
		state.bindAccount('instance::user1');
		state.requireSelection('instance::user1');
		expect(state.requiredAccountKey).toBe('instance::user1');
	});
	test('switch and logout clear prompt, error and read escape state', () => {
		const state = new UsernameSelectionState();
		state.bindAccount('instance::user1');
		state.showPrompt('instance::user1');
		state.requireSelection('instance::user1');
		state.readAllowed('instance::user1');
		state.bindAccount('instance::user2');
		expect(state).toMatchObject({
			accountKey: 'instance::user2',
			requiredAccountKey: null,
			promptAccountKey: null,
			readingAccountKey: null,
		});
		state.requireSelection('instance::user2');
		state.reset();
		expect(state.accountKey).toBeNull();
		expect(state.requiredAccountKey).toBeNull();
	});
	test('late errors and prompt responses from the previous account do not open a screen', () => {
		const state = new UsernameSelectionState();
		state.bindAccount('instance::user2');
		state.requireSelection('instance::user1');
		state.showPrompt('instance::user1');
		expect(state.requiredAccountKey).toBeNull();
		expect(state.promptAccountKey).toBeNull();
	});
	test('read/block/report escape keeps selection required and another denied action returns to the full screen', () => {
		const state = new UsernameSelectionState();
		state.bindAccount('instance::user1');
		state.requireSelection('instance::user1');
		state.readAllowed('instance::user1');
		expect(state.requiredAccountKey).toBe('instance::user1');
		expect(state.readingAccountKey).toBe('instance::user1');
		state.requireSelection('instance::user1');
		expect(state.readingAccountKey).toBeNull();
	});
	test('dismisses the voluntary prompt but clears required state only after selection succeeds', () => {
		const state = new UsernameSelectionState();
		state.bindAccount('instance::user1');
		state.showPrompt('instance::user1');
		expect(state.promptAccountKey).toBe('instance::user1');
		state.dismissPrompt('instance::user1');
		expect(state.promptAccountKey).toBeNull();
		state.requireSelection('instance::user1');
		state.dismissPrompt('instance::user1');
		expect(state.requiredAccountKey).toBe('instance::user1');
		state.finishSelection('instance::user1');
		expect(state.requiredAccountKey).toBeNull();
	});
});
