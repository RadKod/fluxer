// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {PremiumTrialRateLimitConfigs} from '@app/api/rate_limit_configs/PremiumTrialRateLimitConfig';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {getRetryAfterSeconds} from '@app/api/utils/RateLimitUtils';
import {getRequestClientIp} from '@app/api/utils/RequestClientIp';
import {RateLimitError} from '@fluxer/errors/src/domains/core/RateLimitError';
import {getIpNetworkKey} from '@fluxer/ip_utils/src/IpAddress';
import type {Context} from 'hono';

const {bucket, config, scope} = PremiumTrialRateLimitConfigs.PREMIUM_TRIAL_CLAIM_NETWORK;

// The per-user route limit cannot see accounts farmed from one network, so trials also share an IPv4 /24 or
// IPv6 /48 quota (one customer is often handed a /56 or a /48, i.e. 256 or more /64s). The claim spends it only
// after the captcha and every eligibility check passed, so a carrier NAT neighbour cannot use it up with failed
// claims. Test mode opts in with the same header RateLimitMiddleware uses.
export async function spendPremiumTrialNetworkQuota(ctx: Context<HonoEnv>): Promise<void> {
	const enforced = Config.dev.testModeEnabled
		? ctx.req.header('x-fluxer-test-enable-rate-limits') === 'true'
		: !Config.dev.disableRateLimits;
	const rateLimitService = ctx.get('rateLimitService');
	if (!enforced || !rateLimitService) return;
	const ip = getRequestClientIp(ctx);
	const network = (ip && getIpNetworkKey(ip, {ipv4PrefixLength: 24, ipv6PrefixLength: 48})) ?? 'unknown';
	const result = await rateLimitService.checkBucketLimit(`ipnet:${network}:${bucket}`, config);
	if (!result.allowed) {
		throw new RateLimitError({
			retryAfter: getRetryAfterSeconds(result),
			retryAfterDecimal: result.retryAfterDecimal,
			limit: result.limit,
			resetTime: result.resetTime,
			resetAfterDecimal: result.resetAfterDecimal,
			scope,
		});
	}
}
