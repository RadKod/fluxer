// SPDX-License-Identifier: AGPL-3.0-or-later

import {PayriffClient} from '@app/api/payriff/PayriffClient';
import {fakePayriffServer} from '@app/api/test/Setup';
import {describe, expect, it} from 'vitest';

const CONFIG = {secretKey: fakePayriffServer.secretKey, baseUrl: fakePayriffServer.baseUrl, timeoutMs: 10_000};
const CALLBACK = 'https://api.micup.test/v1/payriff/callback/1/abc';

describe('PayriffClient', () => {
	const client = new PayriffClient(CONFIG);

	it('creates a purchase in the order currency, in English with the order callback and the secret as Authorization', async () => {
		const result = await client.createOrder({
			amountMinor: 476,
			currency: 'TRY',
			description: 'Yitik Melek — ₺4,76',
			callbackUrl: CALLBACK,
		});

		const [call] = fakePayriffServer.calls();
		expect(fakePayriffServer.calls()).toHaveLength(1);
		expect(call!.authorization).toBe(fakePayriffServer.secretKey);
		expect(call!.body).toEqual({
			amount: 4.76,
			language: 'EN',
			currency: 'TRY',
			description: 'Yitik Melek — ₺4,76',
			callbackUrl: CALLBACK,
			cardSave: false,
			operation: 'PURCHASE',
		});
		expect(result).toEqual({
			kind: 'ok',
			providerOrderId: call!.providerOrderId,
			paymentUrl: `https://pay.payriff.test/r/${call!.providerOrderId}?type=direct`,
		});
	});

	it('sends minor units as a two-decimal amount and cuts the description at 200 characters', async () => {
		await client.createOrder({amountMinor: 10, currency: 'TRY', description: 'x'.repeat(250), callbackUrl: CALLBACK});
		await client.createOrder({amountMinor: 123_456, currency: 'TRY', description: 'y', callbackUrl: CALLBACK});

		const [small, large] = fakePayriffServer.calls();
		expect(small!.body).toMatchObject({amount: 0.1, description: 'x'.repeat(200)});
		expect(large!.body).toMatchObject({amount: 1234.56});
	});

	it('reads status, operation, amount in minor units and currency', async () => {
		fakePayriffServer.setAmount('payriff-order-9', 4.76, 'TRY');
		fakePayriffServer.setStatus('payriff-order-9', 'APPROVED');

		expect(await client.getOrder('payriff-order-9')).toEqual({
			kind: 'ok',
			paymentStatus: 'APPROVED',
			operationType: 'PURCHASE',
			amountMinor: 476,
			currency: 'TRY',
		});
		expect(fakePayriffServer.calls()[0]).toMatchObject({operation: 'get', providerOrderId: 'payriff-order-9'});
		expect(fakePayriffServer.calls()[0]!.authorization).toBe(fakePayriffServer.secretKey);
	});

	it('answers rate_limited on 429, transient on 500, a non-00000 code and a timeout; not_found on 404', async () => {
		const quick = new PayriffClient({...CONFIG, timeoutMs: 50});
		fakePayriffServer.setStatus('known', 'CREATED');
		const outcomes: Array<string> = [];
		for (const mode of ['rate_limit', 'server_error', 'bad_code', 'timeout'] as const) {
			fakePayriffServer.failNext('get', mode);
			outcomes.push((await quick.getOrder('known')).kind);
		}
		outcomes.push((await quick.getOrder('unknown-order')).kind);

		expect(outcomes).toEqual(['rate_limited', 'transient', 'transient', 'transient', 'not_found']);
	});

	it('answers rate_limited on 429 and failed on 500, a non-00000 code and a timeout when creating', async () => {
		const quick = new PayriffClient({...CONFIG, timeoutMs: 50});
		const outcomes: Array<string> = [];
		for (const mode of ['rate_limit', 'server_error', 'bad_code', 'timeout'] as const) {
			fakePayriffServer.failNext('create', mode);
			outcomes.push(
				(await quick.createOrder({amountMinor: 476, currency: 'TRY', description: 'd', callbackUrl: CALLBACK})).kind,
			);
		}

		expect(outcomes).toEqual(['rate_limited', 'failed', 'failed', 'failed']);
	});

	it('asks for the order ID path-encoded', async () => {
		await client.getOrder('a/b?c');

		expect(fakePayriffServer.calls()).toEqual([expect.objectContaining({operation: 'get', providerOrderId: 'a/b?c'})]);
	});

	// The secret key travels in the Authorization header of every request.
	it('refuses a non-https base url', () => {
		expect(() => new PayriffClient({...CONFIG, baseUrl: 'http://payriff.test/api/v3'})).toThrow();
	});
});
