// SPDX-License-Identifier: AGPL-3.0-or-later

import crypto from 'node:crypto';
import {Config} from '@app/api/Config';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

// The callback token lives only in the callback URL handed to Payriff; the order keeps its SHA-256.
export function createCallbackToken(): {token: string; hash: string} {
	const token = crypto.randomBytes(32).toString('base64url');
	return {token, hash: hashCallbackToken(token)};
}

export function hashCallbackToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

export function callbackTokenMatches(token: string, storedHash: string): boolean {
	if (!TOKEN_PATTERN.test(token) || !HASH_PATTERN.test(storedHash)) return false;
	return crypto.timingSafeEqual(Buffer.from(hashCallbackToken(token), 'hex'), Buffer.from(storedHash, 'hex'));
}

// Payriff needs an https callbackUrl; Config.endpoints.apiPublic is the public https API base.
export function buildCallbackUrl(orderId: bigint, token: string): string {
	return `${Config.endpoints.apiPublic.replace(/\/+$/u, '')}/v1/payriff/callback/${orderId}/${token}`;
}
