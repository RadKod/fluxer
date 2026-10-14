// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';

type Nullish<T> = T | null;

export interface PremiumLedgerRow {
	user_id: UserID;
	paid_until: Nullish<Date>;
	applied_grants: Nullish<Map<string, Date>>;
	trial_used_at: Nullish<Date>;
	version: number;
}

// One row per non-trial grant key (Payriff order, code): the lasting proof that the grant was applied, so a key
// that fell out of applied_grants' 200-key window still never adds time twice.
export interface PremiumGrantKeyRow {
	user_id: UserID;
	grant_key: string;
	state: 'pending' | 'delivered';
	created_at: Date;
	delivered_at: Nullish<Date>;
}

export interface PremiumExpirationByDayRow {
	day: number;
	shard: number;
	user_id: UserID;
}

export const PREMIUM_LEDGER_COLUMNS = [
	'user_id',
	'paid_until',
	'applied_grants',
	'trial_used_at',
	'version',
] as const satisfies ReadonlyArray<keyof PremiumLedgerRow>;

export const PREMIUM_GRANT_KEY_COLUMNS = [
	'user_id',
	'grant_key',
	'state',
	'created_at',
	'delivered_at',
] as const satisfies ReadonlyArray<keyof PremiumGrantKeyRow>;

export const PREMIUM_EXPIRATION_BY_DAY_COLUMNS = ['day', 'shard', 'user_id'] as const satisfies ReadonlyArray<
	keyof PremiumExpirationByDayRow
>;
