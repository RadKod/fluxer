// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {Config} from '@app/api/Config';
import {
	buildCallbackUrl,
	callbackTokenMatches,
	createCallbackToken,
	hashCallbackToken,
} from '@app/api/payriff/PayriffCallbackToken';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('Payriff callback token', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('matches its own token only', () => {
		const first = createCallbackToken();
		const second = createCallbackToken();

		expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(first.hash).toBe(crypto.createHash('sha256').update(first.token).digest('hex'));
		expect(hashCallbackToken(first.token)).toBe(first.hash);
		expect(first.token).not.toBe(second.token);
		expect(callbackTokenMatches(first.token, first.hash)).toBe(true);
		expect(callbackTokenMatches(second.token, first.hash)).toBe(false);
		expect(callbackTokenMatches(first.token, second.hash)).toBe(false);
	});

	it('compares in constant time and refuses other lengths', () => {
		const {token, hash} = createCallbackToken();
		const compare = vi.spyOn(crypto, 'timingSafeEqual');

		expect(callbackTokenMatches(createCallbackToken().token, hash)).toBe(false);
		expect(compare).toHaveBeenCalledTimes(1);
		const [a, b] = compare.mock.calls[0]!;
		expect((a as Buffer).length).toBe((b as Buffer).length);

		compare.mockClear();
		expect(callbackTokenMatches(token.slice(0, 42), hash)).toBe(false);
		expect(callbackTokenMatches(`${token}A`, hash)).toBe(false);
		expect(callbackTokenMatches(token, hash.slice(0, 63))).toBe(false);
		expect(callbackTokenMatches(`${token.slice(0, 42)}=`, hash)).toBe(false);
		expect(callbackTokenMatches(token, '')).toBe(false);
		expect(compare).not.toHaveBeenCalled();
	});

	it('builds the callback URL under /v1/payriff/callback with the order and the token', () => {
		const {token} = createCallbackToken();
		const base = Config.endpoints.apiPublic.replace(/\/+$/u, '');

		expect(buildCallbackUrl(1490000000000000001n, token)).toBe(
			`${base}/v1/payriff/callback/1490000000000000001/${token}`,
		);
	});
});
