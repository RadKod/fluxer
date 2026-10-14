// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	isCriticalGatewayDispatch,
	selectGatewayDispatchFlushMode,
} from '@app/features/gateway/transport/GatewayDispatchScheduling';
import {describe, expect, it} from 'vitest';

describe('gateway dispatch scheduling', () => {
	it('rollout closure bypasses batching and idle waits', () => {
		expect(isCriticalGatewayDispatch('GATEWAY_ROLLOUT_UPDATE')).toBe(true);
		expect(selectGatewayDispatchFlushMode('GATEWAY_ROLLOUT_UPDATE')).toBe('immediate');
	});
	// A table move must reach the other players within 300 ms; the idle-time path can hold an event over a second.
	it('TABLE_GAME_UPDATE is critical', () => {
		expect(isCriticalGatewayDispatch('TABLE_GAME_UPDATE')).toBe(true);
		expect(selectGatewayDispatchFlushMode('TABLE_GAME_UPDATE')).toBe('deferred');
	});

	it('MESSAGE_CREATE stays deferred', () => {
		expect(isCriticalGatewayDispatch('MESSAGE_CREATE')).toBe(false);
		expect(selectGatewayDispatchFlushMode('MESSAGE_CREATE')).toBe('deferred');
	});
});
