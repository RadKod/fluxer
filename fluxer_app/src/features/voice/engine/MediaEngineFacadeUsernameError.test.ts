// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	createMediaEngineFacadeSnapshot,
	selectMediaEngineGatewayErrorDecision,
} from '@app/features/voice/engine/MediaEngineFacadeStateMachine';
import {describe, expect, test} from 'vitest';

describe('username selection voice rejection', () => {
	test('aborts a rejected pending join and its restore attempt', () => {
		expect(
			selectMediaEngineGatewayErrorDecision(createMediaEngineFacadeSnapshot(), {
				code: 'USERNAME_SELECTION_REQUIRED',
				connecting: true,
				connected: false,
				channelId: 'channel-1',
			}),
		).toMatchObject({type: 'handle', abortConnection: true, clearPendingSessionRestore: true, toast: null});
	});
	test('keeps the existing voice connection on a rejected move', () => {
		expect(
			selectMediaEngineGatewayErrorDecision(createMediaEngineFacadeSnapshot(), {
				code: 'USERNAME_SELECTION_REQUIRED',
				connecting: true,
				connected: true,
				channelId: 'channel-1',
			}),
		).toMatchObject({type: 'handle', abortConnection: false, disconnectReason: null, toast: null});
	});
});
