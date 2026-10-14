// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';

type Nullish<T> = T | null;

export interface CosmeticItemRow {
	item_id: bigint;
	item_type: string;
	name: string;
	description: Nullish<string>;
	asset_hash: string;
	availability: string;
	created_at: Date;
	// Ultra decorations only: per-surface size and offset in thousandths (2.30 = 2300); null keeps the fixed sizes.
	ultra_layout: Nullish<Map<string, number>>;
	// Ultra decorations drawn in front (angel-wings): closed, idle, open_00..open_29 → asset hash; null draws behind.
	ultra_front: Nullish<Map<string, string>>;
	version: number;
}

export type CosmeticItemByTypeRow = Omit<CosmeticItemRow, 'version'>;

export interface UserCosmeticRow {
	user_id: UserID;
	item_id: bigint;
	item_type: string;
	source: Nullish<string>;
	acquired_at: Date;
}

// One row per delivery (shop order, item code): the lasting proof that stops a second delivery. 'revoked': an admin
// take-back found this delivery still pending; it never delivers afterwards.
export interface CosmeticGrantRow {
	user_id: UserID;
	grant_key: string;
	item_id: bigint;
	source: string;
	state: 'pending' | 'delivered' | 'revoked';
	created_at: Date;
	delivered_at: Nullish<Date>;
}

export const COSMETIC_ITEM_COLUMNS = [
	'item_id',
	'item_type',
	'name',
	'description',
	'asset_hash',
	'availability',
	'created_at',
	'ultra_layout',
	'ultra_front',
	'version',
] as const satisfies ReadonlyArray<keyof CosmeticItemRow>;

export const COSMETIC_ITEM_BY_TYPE_COLUMNS = [
	'item_type',
	'item_id',
	'name',
	'description',
	'asset_hash',
	'availability',
	'created_at',
	'ultra_layout',
	'ultra_front',
] as const satisfies ReadonlyArray<keyof CosmeticItemByTypeRow>;

export const USER_COSMETIC_COLUMNS = [
	'user_id',
	'item_id',
	'item_type',
	'source',
	'acquired_at',
] as const satisfies ReadonlyArray<keyof UserCosmeticRow>;

export const COSMETIC_GRANT_COLUMNS = [
	'user_id',
	'grant_key',
	'item_id',
	'source',
	'state',
	'created_at',
	'delivered_at',
] as const satisfies ReadonlyArray<keyof CosmeticGrantRow>;
