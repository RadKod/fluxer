// SPDX-License-Identifier: AGPL-3.0-or-later
// the owner's side of a profile view — the users columns the profile response
// reads, the verified connections and the badges — kept 60 s in KV (ProfileAccessCache.readView), so a popular profile
// does not heat the owner's users, user_connections and user_badges partitions. Nothing secret goes in: the columns are an
// allow list, and growing it means checking the test's secret list.

import type {UserBadgeRow} from '@app/api/database/types/BadgeTypes';
import type {UserConnectionRow} from '@app/api/database/types/ConnectionTypes';
import {EMPTY_USER_ROW, type UserRow} from '@app/api/database/types/UserTypes';
import {User} from '@app/api/models/User';

// What mapUserToPartialResponse, mapUserToProfileResponse, the premium fields and their flags, the profile timezone,
// shouldStripExpiredPremium, the animated avatar and banner entitlements (premium and traits), the profile effect and
// the Plus name style and profile theme read.
// Never last_active_*: the account write hook ignores those columns, so they would go stale here.
export const PROFILE_VIEW_USER_COLUMNS = [
	'user_id',
	'username',
	'discriminator',
	'global_name',
	'bot',
	'system',
	'avatar_hash',
	'avatar_color',
	'banner_hash',
	'banner_color',
	'bio',
	'pronouns',
	'accent_color',
	'timezone',
	'timezone_privacy_flags',
	'flags',
	'premium_flags',
	'premium_type',
	'premium_since',
	'premium_until',
	'premium_gift_extension_ends_at',
	'premium_grace_ends_at',
	'premium_lifetime_sequence',
	'pending_deletion_at',
	'deletion_reason_code',
	'temp_banned_until',
	'traits',
	'mention_flags',
	'avatar_decoration_id',
	'avatar_decoration_asset',
	'avatar_ultra_id',
	'avatar_ultra_asset',
	'nameplate_id',
	'nameplate_asset',
	'profile_effect_id',
	'profile_effect_asset',
	'name_font',
	'name_color',
	'name_color_2',
	'theme_primary_color',
	'theme_accent_color',
] as const satisfies ReadonlyArray<keyof UserRow>;

// An SSO identity trait is a stable external account key; no limit rule matches one account's identity.
const SECRET_TRAIT_PREFIX = 'sso_identity:';

export type ProfileViewConnection = Pick<
	UserConnectionRow,
	'connection_id' | 'connection_type' | 'name' | 'verified' | 'visibility_flags' | 'sort_order'
>;

// The catalog text is not kept: BadgeService.toProfileBadges draws it, so a renamed badge shows like before.
export type ProfileViewBadge = Pick<UserBadgeRow, 'badge_id' | 'sequence'>;

export interface CachedProfileView {
	row: Partial<UserRow>;
	connections: Array<ProfileViewConnection>; // verified only, with their visibility flags; no token or grant
	badges: Array<ProfileViewBadge>;
}

export function buildProfileView(
	user: User,
	connections: Array<UserConnectionRow>,
	badges: Array<UserBadgeRow>,
): CachedProfileView {
	const full = user.toRow();
	const row: Record<string, unknown> = {};
	for (const column of PROFILE_VIEW_USER_COLUMNS) row[column] = full[column];
	const traits = [...(full.traits ?? [])].filter((trait) => !trait.startsWith(SECRET_TRAIT_PREFIX));
	row.traits = traits.length > 0 ? new Set(traits) : null;
	return {
		row: row as Partial<UserRow>,
		connections: connections
			.filter((connection) => connection.verified)
			.map(({connection_id, connection_type, name, verified, visibility_flags, sort_order}) => ({
				connection_id,
				connection_type,
				name,
				verified,
				visibility_flags,
				sort_order,
			})),
		badges: badges.map(({badge_id, sequence}) => ({badge_id, sequence})),
	};
}

/** The owner as the profile response sees it; every other column empty. Never a write's base row (patchUpsert). */
export function projectedUser(view: CachedProfileView): User {
	return new User({...EMPTY_USER_ROW, ...view.row});
}

// The FeedRepository $bigint tag, plus Date and Set. JSON.stringify calls Date.toJSON before the replacer sees the
// value, so the replacer looks at the holder's own field.
export function encodeProfileView(view: CachedProfileView): string {
	return JSON.stringify(view, function (this: Record<string, unknown>, key, value) {
		const raw = this[key];
		if (typeof raw === 'bigint') return {$bigint: raw.toString()};
		if (raw instanceof Date) return {$date: raw.getTime()};
		if (raw instanceof Set) return {$set: [...raw]};
		return value;
	});
}

export function decodeProfileView(raw: string): CachedProfileView {
	return JSON.parse(raw, (_key, value) => {
		if (value === null || typeof value !== 'object') return value;
		if ('$bigint' in value) return BigInt(value.$bigint);
		if ('$date' in value) return new Date(value.$date);
		if ('$set' in value) return new Set(value.$set);
		return value;
	}) as CachedProfileView;
}
