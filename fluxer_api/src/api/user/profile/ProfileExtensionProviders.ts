// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {Logger} from '@app/api/Logger';
import type {User} from '@app/api/models/User';
import type {BadgeResponse} from '@fluxer/schema/src/domains/badge/BadgeResponseSchemas';
import type {UserProfileFullResponse} from '@fluxer/schema/src/domains/user/UserResponseSchemas';

// Micup: badges, follow counts and the profile effect add their fields to the profile response
// through these hooks, so no feature task edits the profile mapper and an unregistered hook changes nothing.
export type ProfileExtensionName = 'badges' | 'follow_counts' | 'profile_effect';

export type ProfileExtension = Partial<
	Pick<
		UserProfileFullResponse,
		'badges' | 'profile_effect_data' | 'follower_count' | 'following_count' | 'is_following'
	>
>;

export interface ProfileExtensionContext {
	userId: UserID;
	viewerId: UserID;
	restrictProfile: boolean;
	// The profile's owner, already loaded, so a provider reads its fields without another users read. Micup it is the
	// cached projection (ProfileViewProjection), so a column a provider needs must be on its allow list.
	user: User;
	// Micup the badges from the cached profile view, so the badges provider reads no user_badges partition.
	cachedBadges?: Array<BadgeResponse>;
}

export type ProfileExtensionProvider = (context: ProfileExtensionContext) => Promise<ProfileExtension>;

const registered = new Map<ProfileExtensionName, ProfileExtensionProvider>();

export function registerProfileExtension(name: ProfileExtensionName, provider: ProfileExtensionProvider): () => void {
	const previous = registered.get(name);
	registered.set(name, provider);
	return () => {
		if (previous) {
			registered.set(name, previous);
		} else {
			registered.delete(name);
		}
	};
}

export async function applyProfileExtensions(
	profile: UserProfileFullResponse,
	context: ProfileExtensionContext,
	providers: ReadonlyMap<ProfileExtensionName, ProfileExtensionProvider> = registered,
): Promise<UserProfileFullResponse> {
	const extensions = await Promise.all(
		Array.from(providers, async ([name, provider]) => {
			try {
				return await provider(context);
			} catch (error) {
				// A failing extension (a counter store outage, say) must not take the whole profile down with it.
				Logger.warn({name, userId: context.userId.toString(), error}, 'Profile extension failed, leaving it out');
				return {};
			}
		}),
	);
	for (const extension of extensions) {
		for (const [field, value] of Object.entries(extension)) {
			if (value !== undefined) {
				Object.assign(profile, {[field]: value});
			}
		}
	}
	return profile;
}
