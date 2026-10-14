// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {getRequestClientIp} from '@app/api/utils/RequestClientIp';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {FluxerError} from '@fluxer/errors/src/FluxerError';
import {getIpNetworkKey, parseIpAddress} from '@fluxer/ip_utils/src/IpAddress';
import {createMiddleware} from 'hono/factory';

// Micup: signed-out checks share a subnet budget; signed-in checks use the per-account USER_CHECK_TAG bucket.
export function UsernameAvailabilityRateLimit() {
	return createMiddleware<HonoEnv>(async (ctx, next) => {
		if (
			Config.dev.testModeEnabled
				? ctx.req.header('x-fluxer-test-enable-rate-limits') !== 'true'
				: Config.dev.disableRateLimits
		) {
			await next();
			return;
		}
		const limiter = ctx.get('rateLimitService');
		if (!limiter) throw new FluxerError({code: APIErrorCodes.USERNAME_UNAVAILABLE, status: 503});
		const raw = getRequestClientIp(ctx);
		const ip = raw ? parseIpAddress(raw) : null;
		const key = ip ? getIpNetworkKey(ip.normalized, {ipv4PrefixLength: 24, ipv6PrefixLength: 56}) : 'internal';
		const result = await limiter.checkBucketLimit(`username-availability:subnet:${key}`, {
			limit: 200,
			windowMs: 60_000,
			exemptFromGlobal: true,
		});
		if (!result.allowed)
			throw new RateLimitError({
				retryAfter: result.retryAfter ?? Math.max(1, Math.ceil(result.resetAfterDecimal)),
				retryAfterDecimal: result.retryAfterDecimal,
				limit: result.limit,
				resetTime: result.resetTime,
				resetAfterDecimal: result.resetAfterDecimal,
				scope: 'shared',
			});
		await next();
	});
}
