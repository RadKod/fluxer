// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {parseSnapshotGatewayEvent} from '@app/features/gateway/snapshot/SnapshotDispatchEvent';
import {GatewayConnectionRole} from '@app/features/gateway/transport/GatewayConnectionRole';
import {type GatewayDispatchDelivery, GatewaySocket, GatewayState} from '@app/features/gateway/transport/GatewaySocket';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

vi.mock('@app/features/gateway/transport/GatewayCompression', () => ({
	GatewayCompression: class {},
	isGatewayCompressionError: () => false,
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('marks resumed sound events as replay while delivering live events normally', async () => {
	const socket = new GatewaySocket('wss://example.test', {
		token: 'test',
		apiVersion: 9,
		compression: 'none',
		properties: {
			os: 'test',
			browser: 'test',
			device: 'test',
			locale: 'en-US',
			user_agent: 'test',
			browser_version: '1',
			os_version: '1',
			build_version: '1',
		},
		isMobileLayout: () => false,
		geo: () => ({latitude: null, longitude: null}),
		role: GatewayConnectionRole.FOREGROUND,
	});
	const deliveries: Array<GatewayDispatchDelivery & {isReplay?: boolean}> = [];
	socket.on('dispatch', (delivery) => deliveries.push(delivery));
	const receiver = socket as unknown as {
		handleSocketMessage(event: {data: string}): Promise<void>;
		connectionState: string;
	};
	receiver.connectionState = GatewayState.Reconnecting;
	await receiver.handleSocketMessage({
		data: JSON.stringify({op: 0, t: 'GUILD_SOUNDBOARD_SOUND_PLAY', s: 1, d: {event_id: 'old'}}),
	});
	receiver.connectionState = GatewayState.Connected;
	await receiver.handleSocketMessage({
		data: JSON.stringify({op: 0, t: 'GUILD_SOUNDBOARD_SOUND_PLAY', s: 2, d: {event_id: 'live'}}),
	});
	vi.advanceTimersByTime(5000);
	expect(deliveries).toHaveLength(2);
	expect(deliveries[0].isReplay).toBe(true);
	expect(deliveries[1].isReplay).toBe(false);
	for (const delivery of deliveries) socket.completeDispatchProcessing(delivery.receipt);
	socket.disconnect();
});

it('keeps sound playback outside account snapshots', () => {
	expect(parseSnapshotGatewayEvent('GUILD_SOUNDBOARD_SOUND_PLAY', {event_id: 'ephemeral'})).toBeNull();
});
