// SPDX-License-Identifier: AGPL-3.0-or-later

import {describe, expect, it, vi} from 'vitest';

// A plain recorder: the store persists itself once at import, before any per-test mock reset.
const persisted = vi.hoisted(() => [] as Array<Array<unknown>>);

vi.mock('@app/features/platform/utils/MobXPersistence', () => ({
	makePersistent: async (...args: Array<unknown>) => {
		persisted.push(args);
	},
}));

const {default: FeedTabs} = await import('@app/features/feed/state/FeedTabs');

describe('FeedTabs', () => {
	it('starts on Discover and remembers the chosen tab', () => {
		expect(FeedTabs.selectedTab).toBe('discover');
		expect(persisted).toEqual([[FeedTabs, 'FeedTabs', ['selectedTab']]]);
		FeedTabs.setTab('home');
		expect(FeedTabs.selectedTab).toBe('home');
	});

	it('keeps Your posts chosen for the session only', () => {
		expect(FeedTabs.showMine).toBe(false);
		FeedTabs.setShowMine(true);
		expect(FeedTabs.showMine).toBe(true);
		expect(persisted).toEqual([[FeedTabs, 'FeedTabs', ['selectedTab']]]);
	});
});
