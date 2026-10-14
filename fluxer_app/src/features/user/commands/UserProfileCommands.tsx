// SPDX-License-Identifier: AGPL-3.0-or-later

import {Routes} from '@app/app/Routes';
import {Endpoints} from '@app/features/app/constants/Endpoints';
import Initialization from '@app/features/app/state/Initialization';
import Authentication from '@app/features/auth/state/Authentication';
import * as RouterUtils from '@app/features/navigation/utils/RouterUtils';
import {AccountScopedWork, accountScopedWorkAbortError} from '@app/features/platform/state/AccountScopedWork';
import SessionManager from '@app/features/platform/state/AuthSession';
import {http} from '@app/features/platform/transport/RestTransport';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as ContextMenuCommands from '@app/features/ui/commands/ContextMenuCommands';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as PopoutCommands from '@app/features/ui/commands/PopoutCommands';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {UserProfileModal} from '@app/features/user/components/modals/UserProfileModal';
import {Profile, type ProfileWire} from '@app/features/user/models/Profile';
import UserProfile from '@app/features/user/state/UserProfile';
import UserProfileMobile from '@app/features/user/state/UserProfileMobile';
import Users from '@app/features/user/state/Users';
import {ME} from '@fluxer/constants/src/AppConstants';

const logger = new Logger('UserProfiles');
const pendingRequests: Map<string, Promise<Profile>> = new Map();
let generation = 0;
AccountScopedWork.registerCancellation(() => {
	generation += 1;
	pendingRequests.clear();
});

// Micup: a request without the mutual lists has a key of its own, so it never answers one that
// needs them; one with them answers both.
function buildKey(userId: string, guildId?: string, withMutuals = true): string {
	return `${userId}:${guildId ?? ME}${withMutuals ? '' : ':without-mutuals'}`;
}

function profileScope(guildId?: string): string {
	return guildId ? ` in guild ${guildId}` : '';
}

function profileQuery(guildId: string | undefined, withMutuals: boolean): Record<string, string | boolean> {
	return {
		...(guildId ? {guild_id: guildId} : {}),
		...(withMutuals ? {with_mutual_friends: true, with_mutual_guilds: true} : {}),
	};
}

function cachedProfileOrRequest(
	userId: string,
	guildId: string | undefined,
	withMutuals: boolean,
): Profile | Promise<Profile> | null {
	const existingProfile = UserProfile.getProfile(userId, guildId);
	if (existingProfile && (existingProfile.mutualsLoaded || !withMutuals)) {
		logger.debug(`Using cached profile for user ${userId}${profileScope(guildId)}`);
		return existingProfile;
	}
	const existingRequest =
		pendingRequests.get(buildKey(userId, guildId)) ??
		(withMutuals ? undefined : pendingRequests.get(buildKey(userId, guildId, false)));
	if (existingRequest) {
		logger.debug(`Reusing in-flight profile request for user ${userId}${profileScope(guildId)}`);
		return existingRequest;
	}
	return null;
}

async function requestProfile(userId: string, guildId: string | undefined, withMutuals: boolean): Promise<ProfileWire> {
	const response = await http.get<ProfileWire>(Endpoints.USER_PROFILE(userId), {
		query: profileQuery(guildId, withMutuals),
	});
	return response.body;
}

function storeProfile(profile: ProfileWire, guildId: string | undefined, withMutuals: boolean): Profile {
	Users.handleUserUpdate(profile.user);
	const profileRecord = new Profile(profile, guildId, {mutualsLoaded: withMutuals});
	UserProfile.handleProfileCreate(profileRecord);
	return profileRecord;
}

export async function fetch(
	userId: string,
	guildId?: string,
	force = false,
	{withMutuals = true}: {withMutuals?: boolean} = {},
): Promise<Profile> {
	if (AccountScopedWork.isSuspended) throw accountScopedWorkAbortError();
	const requestGeneration = generation;
	try {
		const key = buildKey(userId, guildId, withMutuals);
		if (!force) {
			const cached = cachedProfileOrRequest(userId, guildId, withMutuals);
			if (cached) return cached;
		} else {
			const existingRequest = pendingRequests.get(key);
			if (existingRequest) {
				logger.debug(
					`Force refresh requested but request already in-flight for user ${userId}${profileScope(guildId)}`,
				);
				return existingRequest;
			} else {
				logger.debug(`Force refreshing profile for user ${userId}${profileScope(guildId)}`);
			}
		}
		logger.debug(`Fetching profile for user ${userId}${profileScope(guildId)}`);
		const promise = (async () => {
			const profile = await requestProfile(userId, guildId, withMutuals);
			if (requestGeneration !== generation) throw accountScopedWorkAbortError();
			const profileRecord = storeProfile(profile, guildId, withMutuals);
			logger.debug(`Fetched and cached profile for user ${userId}${profileScope(guildId)}`);
			return profileRecord;
		})();
		pendingRequests.set(key, promise);
		try {
			const res = await promise;
			if (pendingRequests.get(key) === promise) pendingRequests.delete(key);
			return res;
		} catch (e) {
			if (pendingRequests.get(key) === promise) pendingRequests.delete(key);
			throw e;
		}
	} catch (error) {
		logger.error(`Failed to fetch profile for user ${userId}${profileScope(guildId)}:`, error);
		throw error;
	}
}

export function invalidate(userId: string, guildId?: string): void {
	const scope = guildId ? ` in guild ${guildId}` : '';
	logger.debug(`Invalidating cached profile for user ${userId}${scope}`);
	try {
		UserProfile.handleProfileInvalidate(userId, guildId);
		pendingRequests.delete(buildKey(userId, guildId));
		pendingRequests.delete(buildKey(userId, guildId, false));
	} catch (err) {
		logger.warn('Failed to invalidate cached profile:', err);
	}
}

export function clearCurrentUserProfiles(): void {
	logger.debug('Clearing cached profiles for current user');
	try {
		UserProfile.handleProfilesClear();
		const currentUserId = Authentication.currentUserId;
		if (currentUserId) {
			for (const key of Array.from(pendingRequests.keys())) {
				if (key.startsWith(`${currentUserId}:`)) {
					pendingRequests.delete(key);
				}
			}
		}
	} catch (err) {
		logger.warn('Failed to clear current user profiles:', err);
	}
}

export function canOpenUserProfileSurface(): boolean {
	return Authentication.isAuthenticated && SessionManager.isConnected && Initialization.canNavigateToProtectedRoutes;
}

export function closeUserProfileSurfaces(): void {
	PopoutCommands.closeAll();
	ContextMenuCommands.close();
	UserProfileMobile.close();
	ModalCommands.popAllByType(UserProfileModal);
}

export function openUserProfile(userId: string, guildId?: string, autoFocusNote?: boolean): boolean {
	if (!canOpenUserProfileSurface()) {
		logger.debug(
			`Skipping profile open while protected routes are unavailable for user ${userId}${profileScope(guildId)}`,
		);
		return false;
	}
	if (MobileLayout.enabled) {
		UserProfileMobile.open(userId, guildId, autoFocusNote);
	} else {
		ModalCommands.push(
			modal(() => (
				<UserProfileModal
					userId={userId}
					guildId={guildId}
					autoFocusNote={autoFocusNote}
					data-flx="user.user-profile-commands.open-user-profile.user-profile-modal"
				/>
			)),
		);
	}
	return true;
}

// Micup: a profile ID goes into request paths, so only a plain decimal snowflake passes —
// isProbablyAValidSnowflake also takes '0x10', padded values and 21 digits, since it only asks BigInt().
const PROFILE_ID = /^[0-9]{1,20}$/;
export function isProfileId(value: string): boolean {
	return PROFILE_ID.test(value) && BigInt(value) > 0n;
}

// Micup: the full profile page at /users/<id>. Whatever profile surface is open closes first.
export function openProfilePage(userId: string): boolean {
	if (!isProfileId(userId)) return false;
	closeUserProfileSurfaces();
	ModalCommands.popAll();
	RouterUtils.transitionTo(Routes.userProfile(userId));
	return true;
}
