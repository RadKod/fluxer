// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupHttp} from '@app/app/SetupHttp';
import UsernameSelection from '@app/features/user/state/UsernameSelection';
import {beforeEach, describe, expect, test, vi} from 'vitest';

const fixture = vi.hoisted(() => ({
	installAuth: vi.fn(),
	installResponseObserver: vi.fn(),
	sudoInit: vi.fn(),
	promptInit: vi.fn(),
}));
vi.mock('@app/features/auth/state/AuthSudo', () => ({default: {init: fixture.sudoInit}}));
vi.mock('@app/features/auth/state/SudoPrompt', () => ({default: {init: fixture.promptInit}}));
vi.mock('@app/features/platform/state/AuthSession', () => ({
	default: {currentAccountKey: 'instance::user1', token: 'auth-token'},
}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {identityVersion: '4'}}}));
vi.mock('@app/features/platform/transport/RestTransport', () => ({
	http: {installAuth: fixture.installAuth, installResponseObserver: fixture.installResponseObserver},
}));

beforeEach(() => {
	vi.clearAllMocks();
	UsernameSelection.reset();
	UsernameSelection.bindAccount('instance::user1');
});

describe('shared username selection HTTP error chain', () => {
	test('installs the response observer alongside existing auth and sudo hooks', () => {
		setupHttp();
		expect(fixture.installAuth).toHaveBeenCalledOnce();
		expect(fixture.sudoInit).toHaveBeenCalledOnce();
		expect(fixture.promptInit).toHaveBeenCalledOnce();
		expect(fixture.installResponseObserver).toHaveBeenCalledOnce();
		fixture.installResponseObserver.mock.calls[0][0]({status: 403, body: {code: 'USERNAME_SELECTION_REQUIRED'}});
		expect(UsernameSelection.requiredAccountKey).toBe('instance::user1');
		expect(UsernameSelection.requiredIdentityVersion).toBe('4');
	});
	test('leaves existing authorization failures unchanged', () => {
		setupHttp();
		expect(fixture.installResponseObserver).toHaveBeenCalledOnce();
		fixture.installResponseObserver.mock.calls[0][0]({status: 403, body: {code: 'MISSING_PERMISSIONS'}});
		expect(UsernameSelection.requiredAccountKey).toBeNull();
	});
});
