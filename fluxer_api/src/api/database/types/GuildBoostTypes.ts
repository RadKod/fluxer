// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';

type Nullish<T> = T | null;

export interface GuildBoostRow {
	guild_id: GuildID;
	boost_id: bigint;
	user_id: UserID;
	slot_id: string;
	created_at: Date;
}

export interface UserBoostSlotRow {
	user_id: UserID;
	slot_id: string;
	guild_id: Nullish<GuildID>;
	boost_id: Nullish<bigint>;
	source: Nullish<string>;
	assigned_at: Nullish<Date>;
	version: number;
}

export interface GuildBoostStateRow {
	guild_id: GuildID;
	boost_count: number;
	premium_tier: number;
	granted_features: Nullish<Set<string>>;
	updated_at: Date;
	version: number;
	suppressed_features: Nullish<Set<string>>;
	downgrade_at: Nullish<Date>;
	vanity_release_at: Nullish<Date>;
	pending_feature_changes?: Nullish<string>;
}

export interface GuildPackageRow {
	guild_id: GuildID;
	package_id: bigint;
	premium_tier: number;
	source: Nullish<string>;
	starts_at: Date;
	ends_at: Nullish<Date>;
	created_at: Date;
}

export interface GuildEntitlementExpirationRow {
	day: number;
	shard: number;
	guild_id: GuildID;
	entitlement_id: bigint;
}

export const GUILD_BOOST_COLUMNS = [
	'guild_id',
	'boost_id',
	'user_id',
	'slot_id',
	'created_at',
] as const satisfies ReadonlyArray<keyof GuildBoostRow>;

export const USER_BOOST_SLOT_COLUMNS = [
	'user_id',
	'slot_id',
	'guild_id',
	'boost_id',
	'source',
	'assigned_at',
	'version',
] as const satisfies ReadonlyArray<keyof UserBoostSlotRow>;

export const GUILD_BOOST_STATE_COLUMNS = [
	'guild_id',
	'boost_count',
	'premium_tier',
	'granted_features',
	'updated_at',
	'version',
	'suppressed_features',
	'downgrade_at',
	'vanity_release_at',
	'pending_feature_changes',
] as const satisfies ReadonlyArray<keyof GuildBoostStateRow>;

export const GUILD_PACKAGE_COLUMNS = [
	'guild_id',
	'package_id',
	'premium_tier',
	'source',
	'starts_at',
	'ends_at',
	'created_at',
] as const satisfies ReadonlyArray<keyof GuildPackageRow>;

export const GUILD_ENTITLEMENT_EXPIRATION_COLUMNS = [
	'day',
	'shard',
	'guild_id',
	'entitlement_id',
] as const satisfies ReadonlyArray<keyof GuildEntitlementExpirationRow>;
