// SPDX-License-Identifier: AGPL-3.0-or-later
// cached profile data follows the account at once, not after its 60 s.

import type {UserID} from '@app/api/BrandedTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {getProfileAccessCache} from '@app/api/middleware/ServiceSingletons';
import {
	registerUserAccountWriteHook,
	registerUserBannedHook,
	registerUserGuildsChangedHook,
	registerUserPairChangedHook,
} from '@app/api/user/lifecycle/UserLifecycleHooks';

const ACTIVITY_ONLY_COLUMNS = new Set(['last_active_at', 'last_active_ip']);

// Equal values compare equal whatever their object: a Date by its time, a Set by its members, null and undefined alike.
function columnValue(value: unknown): unknown {
	if (value == null) return null;
	if (value instanceof Date) return value.getTime();
	if (value instanceof Set) return [...value].map(String).sort().join('\n');
	return String(value);
}

function changedColumns(previous: UserRow | null, updated: UserRow): Set<string> {
	if (!previous) return new Set(Object.keys(updated));
	const columns = new Set([...Object.keys(previous), ...Object.keys(updated)]);
	return new Set(
		[...columns].filter(
			(column) => columnValue(previous[column as keyof UserRow]) !== columnValue(updated[column as keyof UserRow]),
		),
	);
}

/** A4: any column change but the activity ones reaches the cached profile view (ProfileViewProjection) at once. */
async function forgetChangedProfileView(changed: Set<string>, userId: UserID): Promise<void> {
	if ([...changed].some((column) => !ACTIVITY_ONLY_COLUMNS.has(column)))
		await getProfileAccessCache().forgetView(userId);
}

/** A1: the owner side of the access decision reads only the flags and the date of birth (the 16-year rule). */
async function forgetChangedProfileSide(changed: Set<string>, userId: UserID): Promise<void> {
	if (changed.has('flags') || changed.has('date_of_birth')) await getProfileAccessCache().forgetSide(userId);
}

export function registerProfileUserLifecycleHooks(): void {
	// The registry keeps one hook per name: every profile cache an account write reaches is dropped in this one.
	registerUserAccountWriteHook('profile', async ({previous, updated}) => {
		const changed = changedColumns(previous, updated);
		await forgetChangedProfileView(changed, updated.user_id);
		await forgetChangedProfileSide(changed, updated.user_id);
	});
	// a block, a friendship, a request or a follow made or undone reaches the pair at once, both ways.
	registerUserPairChangedHook('profile', ({userId, targetId}) =>
		getProfileAccessCache().forgetRelations(userId, targetId),
	);
	// a guild joined or left drops only the account's own side record; every pair record checks its shared guild
	// against both side records (ProfileAccessService.loadRelation), so no member of the guild is touched.
	registerUserGuildsChangedHook('profile', ({userId}) => getProfileAccessCache().forgetSide(userId));
	registerUserBannedHook('profile', ({userId}) => getProfileAccessCache().forgetSide(userId));
}
