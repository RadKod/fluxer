// SPDX-License-Identifier: AGPL-3.0-or-later

import {setupI18n} from '@lingui/core';
import {describe, expect, it, vi} from 'vitest';

vi.mock('@lingui/core/macro', () => ({msg: (descriptor: unknown) => descriptor}));

const {describeFeedNotification} = await import('@app/features/inbox/utils/FeedNotificationText');

// No catalog is loaded, so lingui formats the English source message with the plural rules of the locale.
const i18n = setupI18n({locale: 'en-US', messages: {'en-US': {}}});

describe('describeFeedNotification', () => {
	it('names the only actor', () => {
		expect(describeFeedNotification(i18n, 'post_like', 'Ali', 1)).toBe('Ali liked your post.');
		expect(describeFeedNotification(i18n, 'post_comment', 'Ali', 1)).toBe('Ali commented on your post.');
		expect(describeFeedNotification(i18n, 'follow', 'Ali', 1)).toBe('Ali started following you.');
	});

	it('folds the other actors into a plural count', () => {
		expect(describeFeedNotification(i18n, 'post_like', 'Ali', 2)).toBe('Ali and 1 other liked your post.');
		expect(describeFeedNotification(i18n, 'post_like', 'Ali', 1000)).toBe('Ali and 999 others liked your post.');
		expect(describeFeedNotification(i18n, 'post_comment', 'Ali', 3)).toBe('Ali and 2 others commented on your post.');
		expect(describeFeedNotification(i18n, 'follow', 'Ali', 2)).toBe('Ali and 1 other started following you.');
	});

	it('describes a reply notification with the other count', () => {
		expect(describeFeedNotification(i18n, 'comment_reply', 'Ali', 1)).toBe('Ali replied to your comment.');
		expect(describeFeedNotification(i18n, 'comment_reply', 'Ali', 2)).toBe('Ali and 1 other replied to your comment.');
		expect(describeFeedNotification(i18n, 'comment_reply', 'Ali', 5)).toBe('Ali and 4 others replied to your comment.');
	});
});
