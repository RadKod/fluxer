// SPDX-License-Identifier: AGPL-3.0-or-later

import {ProfilePrivacyLevels} from '@fluxer/constants/src/UserConstants';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = vi.hoisted(() => ({discover: true, level: 0 as number, hydrated: true, publicAllowed: true}));

vi.mock('@app/features/feed/utils/FeedUtils', () => ({isFeedDiscoverEnabled: () => state.discover}));
vi.mock('@app/features/user/state/UserSettings', () => ({
	default: {getProfilePrivacy: () => state.level, isHydrated: () => state.hydrated},
}));
vi.mock('@app/features/user/state/Users', () => ({
	default: {
		get currentUser() {
			return {publicProfileAllowed: state.publicAllowed};
		},
	},
}));

const {canFeedPostsBePublic} = await import('@app/features/feed/utils/FeedPrivacyUtils');

// Micup: only a public profile's posts reach strangers and Discover; the server sets the public bit,
// and this only decides whether the feed says so.
describe('canFeedPostsBePublic', () => {
	beforeEach(() => {
		Object.assign(state, {discover: true, level: ProfilePrivacyLevels.EVERYONE, hydrated: true, publicAllowed: true});
	});

	it('is true for a public profile with Discover on and the settings loaded', () => {
		expect(canFeedPostsBePublic()).toBe(true);
	});

	it.each([0, 1, 2, 101])('is false at level %i', (level) => {
		state.level = level;
		expect(canFeedPostsBePublic()).toBe(false);
	});

	// the server reads a stored 100 as shared communities until the account may have a public profile.
	it('is false for a stored 100 while public_profile_allowed is false', () => {
		state.publicAllowed = false;
		expect(canFeedPostsBePublic()).toBe(false);
	});

	it('is false with Discover off or before the settings load', () => {
		state.discover = false;
		expect(canFeedPostsBePublic()).toBe(false);
		Object.assign(state, {discover: true, hydrated: false});
		expect(canFeedPostsBePublic()).toBe(false);
	});
});
