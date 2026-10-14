// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

vi.mock('@app/features/messaging/utils/MessagingUrlUtils', () => ({marketingUrl: (path: string) => path}));

const {isAutoRedirectExemptPath} = await import('@app/app/router/RouterConstants');

describe('isAutoRedirectExemptPath', () => {
	it('lets a signed-in visitor stay on a /r/<code> referral link', () => {
		expect(isAutoRedirectExemptPath('/r/abcdef2345')).toBe(true);
	});

	it('does not exempt paths that only start with the letter r', () => {
		expect(isAutoRedirectExemptPath('/report')).toBe(true);
		expect(isAutoRedirectExemptPath('/rooms')).toBe(false);
	});
});
