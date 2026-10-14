// SPDX-License-Identifier: AGPL-3.0-or-later

import type {LoggerInterface} from '@fluxer/logger/src/LoggerInterface';
import {ms} from 'itty-time';
import {z} from 'zod';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_MAX_TOKEN_LENGTH = 2048;
const TURNSTILE_TIMEOUT_MS = ms('10 seconds');

const TurnstileVerifyResponseSchema = z.object({
	success: z.boolean(),
	'error-codes': z.array(z.string()).optional(),
});

export interface TurnstileProviderOptions {
	secretKey: string;
	logger?: LoggerInterface;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
}

export class TurnstileProvider {
	private readonly options: TurnstileProviderOptions;

	constructor(options: TurnstileProviderOptions) {
		this.options = options;
	}

	async verify({token, remoteIp}: {token: string; remoteIp?: string}): Promise<boolean> {
		if (token.length === 0 || token.length > TURNSTILE_MAX_TOKEN_LENGTH) return false;
		const body = new URLSearchParams({secret: this.options.secretKey, response: token});
		if (remoteIp) body.set('remoteip', remoteIp);
		const logger = this.options.logger;
		try {
			const response = await (this.options.fetchFn ?? fetch)(TURNSTILE_VERIFY_URL, {
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded'},
				body: body.toString(),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? TURNSTILE_TIMEOUT_MS),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => undefined);
				logger?.error({status: response.status}, 'Turnstile verify request failed');
				return false;
			}
			const parsed = TurnstileVerifyResponseSchema.safeParse(await response.json());
			if (!parsed.success) {
				logger?.error({}, 'Turnstile returned an invalid verification response');
				return false;
			}
			if (!parsed.data.success) {
				logger?.warn({errorCodes: parsed.data['error-codes']}, 'Turnstile verification failed');
				return false;
			}
			return true;
		} catch (error) {
			logger?.error({errorName: error instanceof Error ? error.name : typeof error}, 'Error verifying Turnstile token');
			return false;
		}
	}
}
