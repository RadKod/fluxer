// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import {GatewayConnectionRole} from '@app/features/gateway/transport/GatewayConnectionRole';
import {GatewaySocket} from '@app/features/gateway/transport/GatewaySocket';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

// Text frames do not need the generated compression WASM package.
vi.mock('@app/features/gateway/transport/GatewayCompression', () => ({
	GatewayCompression: class {},
	isGatewayCompressionError: () => false,
}));

function createSocket(): GatewaySocket {
	return new GatewaySocket('wss://gateway.example/', {
		token: 'token-100',
		apiVersion: 9,
		properties: {
			os: 'windows',
			browser: 'Fluxer Client',
			device: 'desktop',
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
}

async function receive(socket: GatewaySocket, data: unknown): Promise<void> {
	await (socket as unknown as {handleSocketMessage(event: {data: string}): Promise<void>}).handleSocketMessage({
		data: JSON.stringify({op: 12, d: data}),
	});
	vi.advanceTimersByTime(5000);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('string voice error wire contract', () => {
	test.each(['USERNAME_SELECTION_REQUIRED', 'VOICE_PERMISSION_DENIED'])(
		'delivers the actual string wire error %s',
		async (code) => {
			const socket = createSocket();
			const received = vi.fn();
			socket.on('gatewayError', received);
			const data = {code, message: 'Select your username'};
			await receive(socket, data);
			expect(received).toHaveBeenCalledWith(data);
		},
	);
	test.each([{code: null, message: 'invalid'}, {code: 403, message: 'invalid'}, {code: 'USERNAME_SELECTION_REQUIRED'}])(
		'rejects malformed gateway errors %j',
		async (data) => {
			const socket = createSocket();
			const received = vi.fn();
			socket.on('gatewayError', received);
			await receive(socket, data);
			expect(received).not.toHaveBeenCalled();
		},
	);
});
