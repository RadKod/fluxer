// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {
	type AccountIdentity as BaseAccountIdentity,
	type AccountIdentityMode,
	AccountIdentityModes,
	DEFAULT_ACCOUNT_IDENTITY_MODE,
	normalizeAccountIdentity,
	type TagStyle,
	TagStyles,
} from '@fluxer/constants/src/AccountIdentityConstants';

// Micup: the stored identity also carries the username migration (see InstanceConfigRepository).
export interface UsernameMigrationConfig {
	state: 'legacy' | 'preparing' | 'selecting';
	epoch: number;
	preparing_at?: string | null;
	started_at: string | null;
	forced_at: string | null;
}

export interface AccountIdentity extends BaseAccountIdentity {
	usernameMigration?: UsernameMigrationConfig;
}

export type StoredAccountIdentity = AccountIdentity;

let cachedStored: StoredAccountIdentity | null = null;
let cachedError: Error | null = null;
let cachedFetchedAt = 0;

export function resolveAccountIdentity(stored: StoredAccountIdentity | null): AccountIdentity {
	if (!Config.instance.selfHosted || !stored) {
		return {
			mode: DEFAULT_ACCOUNT_IDENTITY_MODE,
			tagStyle: TagStyles.RANDOM,
			...(stored?.usernameMigration ? {usernameMigration: {...stored.usernameMigration}} : {}),
		};
	}
	return {
		...normalizeAccountIdentity(stored.mode, stored.tagStyle),
		...(stored.usernameMigration ? {usernameMigration: {...stored.usernameMigration}} : {}),
	};
}

export function getCachedAccountIdentity(): AccountIdentity {
	if (cachedError) throw cachedError;
	return resolveAccountIdentity(cachedStored);
}

// Micup: identity writers act only on a recent snapshot, so with their 30 s deadline they finish inside the 60 s
// preparation barrier; every other caller keeps deciding on the last known value.
const IDENTITY_WRITE_SNAPSHOT_MAX_AGE_MS = 10_000;

export function getFreshCachedAccountIdentity(): AccountIdentity | null {
	const age = Date.now() - cachedFetchedAt;
	return age >= 0 && age <= IDENTITY_WRITE_SNAPSHOT_MAX_AGE_MS ? getCachedAccountIdentity() : null;
}

export function getCachedAccountIdentityFetchedAt(): number {
	return cachedFetchedAt;
}

export function getCachedAccountIdentityMode(): AccountIdentityMode {
	return getCachedAccountIdentity().mode;
}

export function getCachedTagStyle(): TagStyle {
	return getCachedAccountIdentity().tagStyle;
}

export function usesUsernameSignIn(): boolean {
	return getCachedAccountIdentityMode() === AccountIdentityModes.USERNAME;
}

export function usesUniqueUsernames(): boolean {
	return getCachedTagStyle() === TagStyles.NONE;
}

export function setCachedAccountIdentity(stored: StoredAccountIdentity | null, fetchedAt = Date.now()): void {
	cachedError = null;
	cachedStored = stored;
	cachedFetchedAt = fetchedAt;
}

export function invalidateCachedAccountIdentity(error: Error): void {
	cachedStored = null;
	cachedError = error;
}
