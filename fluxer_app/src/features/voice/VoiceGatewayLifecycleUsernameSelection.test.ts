// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GatewayErrorData} from '@app/features/gateway/transport/GatewaySocket';
import UsernameSelection from '@app/features/user/state/UsernameSelection';
import {reportGatewayErrorToVoice} from '@app/features/voice/VoiceGatewayLifecycle';
import {beforeEach, describe, expect, test, vi} from 'vitest';

const fixture = vi.hoisted(() => ({handleGatewayError: vi.fn()}));
vi.mock('@app/features/voice/engine/MediaEngineFacade', () => ({
	default: {handleGatewayError: fixture.handleGatewayError},
}));
vi.mock('@app/features/platform/state/AuthSession', () => ({default: {currentAccountKey: 'instance::user1'}}));
vi.mock('@app/features/user/state/Users', () => ({default: {currentUser: {identityVersion: '4'}}}));

beforeEach(() => {
	vi.clearAllMocks();
	UsernameSelection.reset();
	UsernameSelection.bindAccount('instance::user1');
});

describe('shared username selection voice error chain', () => {
	test('opens the same required root screen while preserving voice error cleanup', () => {
		const error: GatewayErrorData = {code: 'USERNAME_SELECTION_REQUIRED', message: 'Select your username'};
		reportGatewayErrorToVoice(error);
		expect(UsernameSelection.requiredAccountKey).toBe('instance::user1');
		expect(UsernameSelection.requiredIdentityVersion).toBe('4');
		expect(fixture.handleGatewayError).toHaveBeenCalledWith(error);
	});
	test('does not gate an unrelated voice permission error', () => {
		const error: GatewayErrorData = {code: 'VOICE_PERMISSION_DENIED', message: 'Missing permissions'};
		reportGatewayErrorToVoice(error);
		expect(UsernameSelection.requiredAccountKey).toBeNull();
		expect(fixture.handleGatewayError).toHaveBeenCalledWith(error);
	});
});
