// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import {PayriffClient} from '@app/api/payriff/PayriffClient';
import type {NoopLogger} from '@app/api/test/mocks/NoopLogger';
import {fakePayriffServer} from '@app/api/test/Setup';
import {afterEach, describe, expect, it, vi} from 'vitest';

const CONFIG = {secretKey: fakePayriffServer.secretKey, baseUrl: fakePayriffServer.baseUrl, timeoutMs: 10_000};
const CALLBACK = 'https://api.micup.test/v1/payriff/callback/1/abc';

// NoopLogger's levels are instance fields and Logger.child({}) hands back the same instance, so a spy on it sees what
// the code logs; a spy on NoopLogger.prototype would see nothing.
function captureLogs() {
	const logger = Logger.child({}) as unknown as NoopLogger;
	const spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map((level) => vi.spyOn(logger, level));
	return () => spies.flatMap((spy) => spy.mock.calls as Array<Array<unknown>>);
}

describe('Payriff logging', () => {
	const client = new PayriffClient(CONFIG);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('the capture itself works', () => {
		const logs = captureLogs();
		Logger.warn({probe: true}, 'probe');
		expect(logs()).toHaveLength(1);
	});

	it('never logs the secret, the Authorization header, bodies or error objects', async () => {
		const logs = captureLogs();
		for (const mode of ['rate_limit', 'server_error', 'bad_code'] as const) {
			fakePayriffServer.failNext('create', mode);
			await client.createOrder({
				amountMinor: 476,
				currency: 'TRY',
				description: 'Kuzgun — ₺4,76',
				callbackUrl: CALLBACK,
			});
			fakePayriffServer.failNext('get', mode);
			await client.getOrder('unknown-order');
		}
		await client.createOrder({amountMinor: 476, currency: 'TRY', description: 'Kuzgun — ₺4,76', callbackUrl: CALLBACK});
		await client.getOrder('unknown-order');
		fakePayriffServer.failNext('get', 'timeout');
		await new PayriffClient({...CONFIG, timeoutMs: 50}).getOrder('slow');

		// Every failure above left a line, so the checks below are not passing on an empty capture.
		expect(logs().length).toBeGreaterThanOrEqual(7);
		const text = JSON.stringify(logs(), (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
		expect(text).not.toContain(fakePayriffServer.secretKey);
		expect(text.toLowerCase()).not.toContain('authorization');
		expect(text).not.toContain('Operation performed successfully');
		expect(text).not.toContain('Kuzgun');
		expect(text).not.toContain(CALLBACK);
		expect(text).not.toContain('pay.payriff.test');
		expect(
			logs()
				.flat()
				.some((arg) => arg instanceof Error),
		).toBe(false);
	});
});
