// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';

export interface BadgeRow {
	badge_id: bigint;
	icon_hash: string;
	description: string;
	created_at: Date;
	version: number;
}

export interface BadgeCatalogRow extends Omit<BadgeRow, 'version'> {
	catalog: number;
}

export type PioneerStatus = 'off' | 'backfilling' | 'open' | 'closed';
export type PioneerUserStatus = 'claiming' | 'granted' | 'revoked' | 'excluded' | 'deleted' | 'late';

export interface UserBadgeRow {
	user_id: UserID;
	badge_id: bigint;
	granted_at: Date;
	// Micup Öncü: the account's pioneer number, filled into {n} of the catalog text; null for every other badge.
	sequence: number | null;
}

// One partition per number: a claim is an INSERT IF NOT EXISTS on its own row. The row is never deleted, so a
// number is never handed out twice; account deletion only clears user_id.
export interface PioneerSlotRow {
	slot: number;
	user_id: UserID | null;
	assigned_at: Date;
}

// The permanent per-account record: one number per account for good (re-verification, e-mail change, bounce and
// ban/unban all hit this row). probe_from fixes where the account's claim scans, so a retry adopts its own slot.
export interface PioneerByUserRow {
	user_id: UserID;
	slot: number | null;
	probe_from: number;
	status: PioneerUserStatus;
	updated_at: Date;
}

export interface PioneerStateRow {
	id: number;
	badge_id: bigint | null;
	status: PioneerStatus;
	next_slot: number;
	updated_at: Date;
}

export const BADGE_COLUMNS = [
	'badge_id',
	'icon_hash',
	'description',
	'created_at',
	'version',
] as const satisfies ReadonlyArray<keyof BadgeRow>;

export const BADGE_CATALOG_COLUMNS = [
	'catalog',
	'badge_id',
	'icon_hash',
	'description',
	'created_at',
] as const satisfies ReadonlyArray<keyof BadgeCatalogRow>;

export const USER_BADGE_COLUMNS = ['user_id', 'badge_id', 'granted_at', 'sequence'] as const satisfies ReadonlyArray<
	keyof UserBadgeRow
>;

export const PIONEER_SLOT_COLUMNS = ['slot', 'user_id', 'assigned_at'] as const satisfies ReadonlyArray<
	keyof PioneerSlotRow
>;

export const PIONEER_BY_USER_COLUMNS = [
	'user_id',
	'slot',
	'probe_from',
	'status',
	'updated_at',
] as const satisfies ReadonlyArray<keyof PioneerByUserRow>;

export const PIONEER_STATE_COLUMNS = [
	'id',
	'badge_id',
	'status',
	'next_slot',
	'updated_at',
] as const satisfies ReadonlyArray<keyof PioneerStateRow>;
