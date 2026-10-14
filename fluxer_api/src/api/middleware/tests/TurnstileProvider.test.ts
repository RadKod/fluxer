// SPDX-License-Identifier: AGPL-3.0-or-later

import type {LoggerInterface} from '@fluxer/logger/src/LoggerInterface';
import {TURNSTILE_VERIFY_URL, TurnstileProvider} from '@pkgs/captcha/src/providers/TurnstileProvider';
import {describe, expect, it, vi} from 'vitest';

const SECRET = 'turnstile-secret-never-logged';
const TOKEN = 'turnstile-token-never-logged';

function createLogger(): {logger: LoggerInterface; lines: () => string} {
	const calls: Array<unknown> = [];
	const record = (...args: Array<unknown>) => {
		calls.push(args);
	};
	const logger = {debug: record, info: record, warn: record, error: record} as unknown as LoggerInterface;
	return {logger, lines: () => JSON.stringify(calls)};
}

function replyWith(response: Response | Error) {
	return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
		if (response instanceof Error) throw response;
		return response;
	});
}

describe('TurnstileProvider', () => {
	it('posts the secret, the token and the client address to siteverify and accepts a success', async () => {
		const fetchFn = replyWith(Response.json({success: true}));
		const provider = new TurnstileProvider({secretKey: SECRET, fetchFn});

		await expect(provider.verify({token: TOKEN, remoteIp: '203.0.113.7'})).resolves.toBe(true);

		const [url, init] = fetchFn.mock.calls[0];
		expect(url).toBe(TURNSTILE_VERIFY_URL);
		expect(init?.method).toBe('POST');
		const form = new URLSearchParams(String(init?.body));
		expect([form.get('secret'), form.get('response'), form.get('remoteip')]).toEqual([SECRET, TOKEN, '203.0.113.7']);
	});

	it.each([
		['a refusal', Response.json({success: false, 'error-codes': ['timeout-or-duplicate']})],
		['a server error', new Response('oops', {status: 500})],
		['a malformed reply', Response.json({ok: true})],
		['a non-JSON reply', new Response('<html>', {status: 200})],
		['a network failure', new TypeError('fetch failed')],
	])('rejects %s without logging the secret or the token', async (_name, reply) => {
		const {logger, lines} = createLogger();
		const provider = new TurnstileProvider({secretKey: SECRET, fetchFn: replyWith(reply), logger});

		await expect(provider.verify({token: TOKEN})).resolves.toBe(false);
		expect(lines()).not.toContain(SECRET);
		expect(lines()).not.toContain(TOKEN);
	});

	it('rejects an empty or oversized token without calling Cloudflare', async () => {
		const fetchFn = replyWith(Response.json({success: true}));
		const provider = new TurnstileProvider({secretKey: SECRET, fetchFn});

		await expect(provider.verify({token: ''})).resolves.toBe(false);
		await expect(provider.verify({token: 'x'.repeat(2049)})).resolves.toBe(false);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
