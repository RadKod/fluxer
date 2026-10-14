// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {Config} from '@app/api/Config';
import {AuthRateLimitConfigs} from '@app/api/rate_limit_configs/AuthRateLimitConfig';
import {UsernameAvailabilityRateLimit} from '@app/api/rate_limit_configs/UsernameAvailabilityRateLimit';
import {createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {Hono} from 'hono';
import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('username availability IP admission', () => {
	it('sets the unauthenticated IP bucket to 20 per minute', () => {
		expect(AuthRateLimitConfigs.AUTH_USERNAME_AVAILABILITY.config).toMatchObject({limit: 20, windowMs: 60_000});
	});
	it.each([
		['192.0.2.1', '192.0.2.254'],
		['2001:db8:abcd:1201::1', '2001:db8:abcd:12fe::2'],
	])('shares the subnet budget across %s and %s', async (first, second) => {
		const calls: Array<string> = [];
		const checkBucketLimit = vi.fn(async (key: string) => {
			calls.push(key);
			return {
				allowed: true,
				limit: 200,
				remaining: 199,
				resetTime: new Date(Date.now() + 60_000),
				resetAfterDecimal: 60,
			};
		});
		const previousTrust = Config.proxy.trust_client_ip_header;
		const previousHeader = Config.proxy.client_ip_header;
		Config.proxy.trust_client_ip_header = true;
		Config.proxy.client_ip_header = 'x-client-ip';
		try {
			const app = new Hono<HonoEnv>();
			app.use('*', async (ctx, next) => {
				ctx.set('rateLimitService', {checkBucketLimit} as never);
				await next();
			});
			app.get('/', UsernameAvailabilityRateLimit(), (ctx) => ctx.json({available: true}));
			for (const ip of [first, second])
				await app.request('http://localhost/', {
					headers: {'x-client-ip': ip, 'x-fluxer-test-enable-rate-limits': 'true'},
				});
			expect(checkBucketLimit).toHaveBeenCalledTimes(2);
			expect(calls[0]).toBe(calls[1]);
			expect(checkBucketLimit).toHaveBeenCalledWith(expect.any(String), {
				limit: 200,
				windowMs: 60_000,
				exemptFromGlobal: true,
			});
		} finally {
			Config.proxy.trust_client_ip_header = previousTrust;
			Config.proxy.client_ip_header = previousHeader;
		}
	});
});

describe('signed-in username availability', () => {
	it('leaves the signed-in check to the per-account Fluxer bucket instead of a shared IP budget', async () => {
		const harness = await createApiTestHarness();
		try {
			const accounts = [await createTestAccount(harness), await createTestAccount(harness)];
			const statuses: Array<number> = [];
			for (const account of accounts)
				for (let index = 0; index < 31; index++) {
					const {response} = await createBuilder(harness, account.token)
						.get(`/users/check-tag?username=free${index}&discriminator=1234`)
						.header('x-fluxer-test-enable-rate-limits', 'true')
						.executeRaw();
					statuses.push(response.status);
				}
			expect(statuses.filter((status) => status === 429)).toEqual([]);
		} finally {
			await harness.shutdown();
		}
	}, 60000);
});
