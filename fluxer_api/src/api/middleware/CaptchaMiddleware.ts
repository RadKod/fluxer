// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHmac} from 'node:crypto';
import {Config} from '@app/api/Config';
import {sharedListHas} from '@app/api/infrastructure/activity/SharedLists';
import {usesUsernameSignIn} from '@app/api/instance/AccountIdentityModeCache';
import type {InstanceCaptchaEffectiveConfig} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import {getKVClient} from '@app/api/middleware/ServiceRegistry';
import type {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {extractEmailDomain} from '@app/api/utils/EmailDomainUtils';
import {Headers} from '@fluxer/constants/src/Headers';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {CaptchaRequiredError, InvalidCaptchaError} from '@fluxer/errors/src/CaptchaErrors';
import {extractClientIp} from '@fluxer/ip_utils/src/ClientIp';
import type {CaptchaConfig} from '@fluxer/schema/src/domains/admin/CaptchaSchemas';
import {AltchaProvider} from '@pkgs/captcha/src/providers/AltchaProvider';
import {TurnstileProvider} from '@pkgs/captcha/src/providers/TurnstileProvider';
import type {Context} from 'hono';
import {createMiddleware} from 'hono/factory';

const ALTCHA_SPENT_CHALLENGE_KEY_PREFIX = 'captcha:altcha:spent:';
const TEST_ENABLE_CAPTCHA_HEADER = 'x-fluxer-test-enable-captcha';

function deriveAltchaSecret(label: string): string {
	return createHmac('sha256', Config.auth.sudoModeSecret).update(label).digest('hex');
}

function createAltchaProvider(config: CaptchaConfig): AltchaProvider {
	return new AltchaProvider({
		hmacSignatureSecret: deriveAltchaSecret('fluxer-altcha-challenge-signature-v1'),
		hmacKeySignatureSecret: deriveAltchaSecret('fluxer-altcha-key-signature-v1'),
		cost: config.cost,
		maxCounter: config.max_counter,
		claimChallenge: (signature, ttlSeconds) =>
			getKVClient().setnx(`${ALTCHA_SPENT_CHALLENGE_KEY_PREFIX}${signature}`, '1', ttlSeconds),
		logger: Logger,
	});
}

async function altchaChallengeData(altcha: AltchaProvider): Promise<Record<string, unknown>> {
	return {captcha_provider: 'altcha', altcha_challenge: await altcha.createChallenge()};
}

async function verifyTurnstileToken(
	ctx: Context<HonoEnv>,
	config: Extract<InstanceCaptchaEffectiveConfig, {provider: 'turnstile'}>,
	token: string | undefined,
): Promise<true> {
	const challenge = {captcha_provider: 'turnstile', turnstile_site_key: config.turnstile_site_key};
	if (!token) {
		throw new CaptchaRequiredError(challenge);
	}
	const turnstile = new TurnstileProvider({secretKey: config.turnstile_secret_key, logger: Logger});
	const remoteIp = extractClientIp(ctx.req.raw, {
		trustClientIpHeader: Config.proxy.trust_client_ip_header,
		clientIpHeaderName: Config.proxy.client_ip_header,
	});
	if (!(await turnstile.verify({token, remoteIp: remoteIp ?? undefined}))) {
		throw new InvalidCaptchaError(challenge);
	}
	return true;
}

export async function verifyCaptchaToken(ctx: Context<HonoEnv>): Promise<boolean> {
	if (Config.dev.testModeEnabled && ctx.req.header(TEST_ENABLE_CAPTCHA_HEADER) !== 'true') return false;
	const config = await ctx.get('instanceConfigRepository').getEffectiveCaptchaConfig();
	if (config.provider === 'none') return false;
	const user = ctx.get('user') as User | undefined;
	if (sharedListHas('email_domain_exempt', extractEmailDomain(user?.email))) return false;
	if (userHasCaptchaExemptFlag(user)) return false;
	if (!user && (await requestUserHasCaptchaExemptFlag(ctx))) return false;
	const token = ctx.req.header(Headers.X_CAPTCHA_TOKEN);
	if (config.provider === 'turnstile') return await verifyTurnstileToken(ctx, config, token);
	const altcha = createAltchaProvider(config);
	if (!token) {
		throw new CaptchaRequiredError(await altchaChallengeData(altcha));
	}
	if (!(await altcha.verify({token}))) {
		throw new InvalidCaptchaError(await altchaChallengeData(altcha));
	}
	return true;
}

function userHasCaptchaExemptFlag(user: User | null | undefined): boolean {
	return user != null && (user.flags & UserFlags.APP_STORE_REVIEWER) !== 0n;
}

async function requestUserHasCaptchaExemptFlag(ctx: Context<HonoEnv>): Promise<boolean> {
	if (usesUsernameSignIn()) return false;
	try {
		const body = (await ctx.req.raw.clone().json()) as unknown;
		if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
		const email = (body as Record<string, unknown>).email;
		if (typeof email !== 'string') return false;
		const user = await ctx.get('userRepository').findByEmail(email);
		return userHasCaptchaExemptFlag(user);
	} catch {
		return false;
	}
}

export const CaptchaMiddleware = createMiddleware<HonoEnv>(async (ctx, next) => {
	ctx.set('captchaVerified', await verifyCaptchaToken(ctx));
	await next();
});
