// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHmac, timingSafeEqual} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import {Config} from '@app/api/Config';

// A view ticket proves the caller got this post in a response of their own (the access check ran
// then), so POST /feed/views never reads a post or KV to judge an ID.
// Key: HMAC-SHA256(FLUXER_CONNECTION_INITIATION_SECRET, label), the way upstream HarvestDownloadToken derives its key
// from that secret; the config loader requires it on every instance, so there is no new env.
const KEY_LABEL = 'micup.feed-view-ticket.v1';
export const FEED_VIEW_TICKET_TTL_SECONDS = 12 * 3600;
const TICKET_PATTERN = /^([1-9]\d{0,11})\.([A-Za-z0-9_-]{22})$/;

let derived: {secret: string; key: Buffer} | null = null;

function ticketKey(secret: string): Buffer {
	if (derived?.secret !== secret) derived = {secret, key: createHmac('sha256', secret).update(KEY_LABEL).digest()};
	return derived.key;
}

// The first 16 bytes of the HMAC, as 22 base64url characters.
function signature(secret: string, viewerId: UserID, postId: bigint, expires: number): string {
	return createHmac('sha256', ticketKey(secret))
		.update(`${viewerId}:${postId}:${expires}`)
		.digest()
		.subarray(0, 16)
		.toString('base64url');
}

/** `<expires>.<signature>`: for this viewer and this post only, valid 12 hours. */
export function signFeedViewTicket(
	viewerId: UserID,
	postId: bigint,
	nowMs: number,
	secret = Config.auth.connectionInitiationSecret,
): string {
	const expires = Math.floor(nowMs / 1000) + FEED_VIEW_TICKET_TTL_SECONDS;
	return `${expires}.${signature(secret, viewerId, postId, expires)}`;
}

/**
 * Never throws. The expiry takes no leading zero and the signature is compared as text, so only the one canonical
 * spelling of a ticket passes.
 */
export function verifyFeedViewTicket(
	viewerId: UserID,
	postId: bigint,
	ticket: string,
	nowMs: number,
	secret = Config.auth.connectionInitiationSecret,
): boolean {
	const match = TICKET_PATTERN.exec(ticket);
	if (!match) return false;
	const expires = Number(match[1]);
	if (expires * 1000 <= nowMs) return false;
	return timingSafeEqual(Buffer.from(match[2]!), Buffer.from(signature(secret, viewerId, postId, expires)));
}
