// SPDX-License-Identifier: AGPL-3.0-or-later

import Authentication from '@app/features/auth/state/Authentication';
import FeedSuggestionPicks from '@app/features/feed/state/FeedSuggestionPicks';
import FeedTimeline from '@app/features/feed/state/FeedTimeline';
import FollowLists from '@app/features/follow/state/FollowLists';
import type {Profile, ProfileWire} from '@app/features/user/models/Profile';
import type {User} from '@app/features/user/models/User';
import UserProfile from '@app/features/user/state/UserProfile';
import Users from '@app/features/user/state/Users';
import {ME} from '@fluxer/constants/src/AppConstants';
import {runInAction} from 'mobx';

type FollowCountKey = 'follower_count' | 'following_count';

// The follow fields are the same in every guild scope of a user's profile, so any cached scope will do.
export function getFollowProfile(userId: string): Profile | null {
	const scopes = UserProfile.profiles[userId];
	return scopes?.[ME] ?? Object.values(scopes ?? {})[0] ?? null;
}

// The server leaves the fields out where the viewer may not see them (restricted profile), so a missing field
// hides its control rather than showing a zero.
export function getFollowControls(
	profile: Profile,
	user: User,
	currentUserId: string | null,
): {canFollow: boolean; showCounts: boolean} {
	return {
		canFollow: user.id !== currentUserId && !user.bot && !user.system && profile.isFollowing != null,
		showCounts: profile.followerCount != null && profile.followingCount != null,
	};
}

const POST_FOLLOW_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

// Micup akis-takip: the standing the server asks of a stranger who follows through a Discover post (the public commenter
// rule, FeedDiscoverRules.isPublicCommenterEligible): a verified email, a claimed account, 24 hours old. The spam and
// suspicious flags are not on the client; the server's 403 covers them.
export function canFollowThroughPost(
	user: Pick<User, 'verified' | 'isClaimed' | 'createdAt'> | null,
	now = Date.now(),
): boolean {
	return (
		user?.verified === true && user.isClaimed() && now - user.createdAt.getTime() >= POST_FOLLOW_MIN_ACCOUNT_AGE_MS
	);
}

function updateProfiles(userId: string, change: (profile: Profile) => Partial<ProfileWire> | null): boolean {
	let changed = false;
	for (const profile of Object.values(UserProfile.profiles[userId] ?? {})) {
		const updates = change(profile);
		if (!updates) continue;
		changed = true;
		if (Users.getUser(userId)) {
			UserProfile.handleProfileCreate(profile.withUpdates(updates));
		} else {
			// withUpdates rebuilds from the cached user; without it the next open fetches the profile again.
			UserProfile.handleProfileInvalidate(userId, profile.guildId ?? undefined);
		}
	}
	return changed;
}

export function shiftFollowCount(userId: string, key: FollowCountKey, delta: number): void {
	updateProfiles(userId, (profile) => {
		const count = key === 'follower_count' ? profile.followerCount : profile.followingCount;
		return count == null ? null : {[key]: Math.max(0, count + delta)};
	});
}

// Idempotent: only a profile, a Discover card or a person suggested beside the feed whose follow state actually flips
// moves the counts, so the optimistic update and the FOLLOW_CREATE/FOLLOW_DELETE echo of the same follow count it once.
// Returns whether anything flipped.
export function applyFollowChange(targetUserId: string, following: boolean): boolean {
	const delta = following ? 1 : -1;
	return runInAction(() => {
		const changed = updateProfiles(targetUserId, (profile) => {
			if (profile.isFollowing === following) return null;
			const followerCount = profile.followerCount == null ? undefined : Math.max(0, profile.followerCount + delta);
			return {is_following: following, follower_count: followerCount};
		});
		// Micup akis-takip: the Discover cards of the author follow the same change (the pill reads them).
		const cardsChanged = FeedTimeline.handleAuthorFollowing(targetUserId, following);
		// Micup akis-oneri: and the people suggested beside the feed (their profiles are not cached).
		const picksChanged = FeedSuggestionPicks.handleFollowing(targetUserId, following);
		// Micup: and the rows of an open follow window (their profiles are not cached either).
		const rowsChanged = FollowLists.handleFollowing(targetUserId, following);
		const currentUserId = Authentication.currentUserId;
		if ((changed || cardsChanged || picksChanged || rowsChanged) && currentUserId) {
			shiftFollowCount(currentUserId, 'following_count', delta);
		}
		return changed || cardsChanged || picksChanged || rowsChanged;
	});
}
