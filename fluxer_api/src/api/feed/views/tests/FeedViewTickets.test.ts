// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {FEED_VIEW_TICKET_TTL_SECONDS, signFeedViewTicket, verifyFeedViewTicket} from '@app/api/feed/views/FeedViews';
import {describe, expect, it} from 'vitest';

const SECRET = 'feed-view-ticket-test-secret';
const NOW = Date.UTC(2026, 8, 28, 12);
const TTL_MS = FEED_VIEW_TICKET_TTL_SECONDS * 1000;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const viewer = createUserID(1_000_000_000_000_001n);
const other = createUserID(1_000_000_000_000_002n);
const post = 1_500_000_000_000_000_000n;

describe('feed view tickets', () => {
	it('accepts its own ticket until it expires', () => {
		const ticket = signFeedViewTicket(viewer, post, NOW, SECRET);

		expect(ticket).toMatch(/^\d{1,12}\.[A-Za-z0-9_-]{22}$/);
		expect(ticket.length).toBeLessThanOrEqual(64);
		expect(verifyFeedViewTicket(viewer, post, ticket, NOW, SECRET)).toBe(true);
		expect(verifyFeedViewTicket(viewer, post, ticket, NOW + TTL_MS - 1000, SECRET)).toBe(true);
	});

	it('refuses a ticket of another viewer, another post, or past its expiry', () => {
		const ticket = signFeedViewTicket(viewer, post, NOW, SECRET);

		expect(verifyFeedViewTicket(other, post, ticket, NOW, SECRET)).toBe(false);
		expect(verifyFeedViewTicket(viewer, post + 1n, ticket, NOW, SECRET)).toBe(false);
		expect(verifyFeedViewTicket(viewer, post, ticket, NOW + TTL_MS, SECRET)).toBe(false);
	});

	it('refuses a forged or malformed ticket without throwing', () => {
		const ticket = signFeedViewTicket(viewer, post, NOW, SECRET);
		const [expires, sig] = ticket.split('.') as [string, string];
		// The same 16 bytes under another last character: base64url ignores its low four bits.
		const twin = `${sig.slice(0, 21)}${BASE64URL[BASE64URL.indexOf(sig.at(-1)!) ^ 1]}`;
		expect(Buffer.from(twin, 'base64url')).toEqual(Buffer.from(sig, 'base64url'));
		const forged = [
			'',
			'.',
			expires,
			sig,
			`${Number(expires) + 3600}.${sig}`,
			`${expires}.${'A'.repeat(22)}`,
			`${expires}.${sig.slice(0, 21)}`,
			`${expires}.${sig}A`,
			`${expires}.${sig}=`,
			`${expires}.${twin}`,
			`-${expires}.${sig}`,
			`${expires}0.${sig}`,
			`0${expires}.${sig}`,
			`1e10.${sig}`,
			` ${ticket}`,
			`${ticket}.${sig}`,
			'x'.repeat(64),
			`${'9'.repeat(13)}.${sig}`,
		];

		for (const candidate of forged) {
			expect(verifyFeedViewTicket(viewer, post, candidate, NOW, SECRET), candidate).toBe(false);
		}
	});

	it('refuses a ticket made under another secret', () => {
		const ticket = signFeedViewTicket(viewer, post, NOW, 'another-secret');

		expect(verifyFeedViewTicket(viewer, post, ticket, NOW, SECRET)).toBe(false);
		expect(verifyFeedViewTicket(viewer, post, ticket, NOW, 'another-secret')).toBe(true);
	});
});
