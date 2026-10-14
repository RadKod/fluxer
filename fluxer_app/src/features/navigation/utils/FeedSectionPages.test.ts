// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveSectionPagePath} from '@app/features/navigation/utils/FeedSectionPages';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({marketingUrl: (path: string) => path}));

describe('resolveSectionPagePath', () => {
	it.each([
		['/feed', '/premium', '/feed/premium'],
		['/feed', '/shop', '/feed/shop'],
		['/feed', '/bots', '/feed/bots'],
		['/feed', '/shop?set=42', '/feed/shop?set=42'],
		['/feed/posts/7', '/premium', '/feed/premium'],
		['/feed/premium', '/shop', '/feed/shop'],
		['/feed/shop', '/shop?set=42', '/feed/shop?set=42'],
	])('opens a shared page from %s beside the feed: %s → %s', (current, path, expected) => {
		expect(resolveSectionPagePath(path, current)).toBe(expected);
	});

	it.each([
		['/channels/@me', '/premium'],
		['/channels/@me/1', '/shop?set=42'],
		['/premium', '/shop'],
		['/channels/1/2', '/bots'],
		['/feedback', '/premium'],
	])('keeps the DM list page outside the feed: from %s, %s', (current, path) => {
		expect(resolveSectionPagePath(path, current)).toBe(path);
	});

	it.each(['/feed', '/feed/posts/7', '/channels/@me', '/premium-callback', '/shopping', '/users/1'])(
		'leaves every other path alone, %s included',
		(path) => {
			expect(resolveSectionPagePath(path, '/feed')).toBe(path);
		},
	);
});
