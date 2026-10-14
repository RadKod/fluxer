// SPDX-License-Identifier: AGPL-3.0-or-later

import DeveloperOptions from '@app/features/devtools/state/DeveloperOptions';
import {HttpError} from '@app/features/platform/types/EndpointError';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import type {Profile} from '@app/features/user/models/Profile';
import UserProfile from '@app/features/user/state/UserProfile';
import {useEffect, useState} from 'react';

interface UseUserProfileSurfaceStateOptions {
	userId: string;
	guildId?: string;
	enabled: boolean;
	fallbackProfile: Profile;
	onError?: (error: unknown) => void;
	// Micup: the page asks without the mutual lists; a profile cached without them does not answer a
	// surface that shows them (the modal and the popup, by default), which shows it while asking again.
	withMutuals?: boolean;
}

interface UserProfileSurfaceState {
	profile: Profile | null;
	profileLoadError: boolean;
	// The HTTP status of a failed load (the page tells 403 from 404); null otherwise.
	profileLoadStatus: number | null;
	isProfileLoading: boolean;
	showProfileSkeleton: boolean;
}

const PROFILE_LOAD_DELAY_MS = 3000;

function answersSurface(cached: Profile | null, withMutuals: boolean): cached is Profile {
	return cached != null && (cached.mutualsLoaded || !withMutuals);
}

export function useUserProfileSurfaceState({
	userId,
	guildId,
	enabled,
	fallbackProfile,
	onError,
	withMutuals = true,
}: UseUserProfileSurfaceStateOptions): UserProfileSurfaceState {
	const [profile, setProfile] = useState<Profile | null>(() => {
		if (!enabled) {
			return fallbackProfile;
		}
		return UserProfile.getProfile(userId, guildId);
	});
	const [profileLoadError, setProfileLoadError] = useState(false);
	const [profileLoadStatus, setProfileLoadStatus] = useState<number | null>(null);
	const [isProfileLoading, setIsProfileLoading] = useState(
		() => enabled && !answersSurface(UserProfile.getProfile(userId, guildId), withMutuals),
	);

	useEffect(() => {
		let cancelled = false;
		setProfileLoadStatus(null);
		if (!enabled) {
			setProfile(fallbackProfile);
			setProfileLoadError(false);
			setIsProfileLoading(false);
			return () => {
				cancelled = true;
			};
		}
		const cachedProfile = UserProfile.getProfile(userId, guildId);
		if (answersSurface(cachedProfile, withMutuals)) {
			setProfile(cachedProfile);
			setProfileLoadError(false);
			setIsProfileLoading(false);
			return () => {
				cancelled = true;
			};
		}
		setProfile(cachedProfile);
		setProfileLoadError(false);
		setIsProfileLoading(true);
		const fetchProfile = async () => {
			try {
				if (DeveloperOptions.slowProfileLoad) {
					await new Promise((resolve) => setTimeout(resolve, PROFILE_LOAD_DELAY_MS));
				}
				if (cancelled) {
					return;
				}
				const fetchedProfile = await UserProfileCommands.fetch(userId, guildId, false, {withMutuals});
				if (cancelled) {
					return;
				}
				setProfile(fetchedProfile);
				setProfileLoadError(false);
			} catch (error) {
				if (cancelled) {
					return;
				}
				onError?.(error);
				setProfile(UserProfile.getProfile(userId, guildId) ?? fallbackProfile);
				setProfileLoadError(true);
				setProfileLoadStatus(error instanceof HttpError ? error.status : null);
			} finally {
				if (!cancelled) {
					setIsProfileLoading(false);
				}
			}
		};
		void fetchProfile();
		return () => {
			cancelled = true;
		};
	}, [enabled, fallbackProfile, guildId, onError, userId, withMutuals]);

	return {
		profile,
		profileLoadError,
		profileLoadStatus,
		isProfileLoading,
		showProfileSkeleton: DeveloperOptions.forceProfileSkeletons || (enabled && isProfileLoading && !profile),
	};
}
