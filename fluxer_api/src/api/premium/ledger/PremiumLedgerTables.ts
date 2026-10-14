// SPDX-License-Identifier: AGPL-3.0-or-later

import {defineTable} from '@app/api/database/CassandraTableDsl';
import {
	PREMIUM_EXPIRATION_BY_DAY_COLUMNS,
	PREMIUM_GRANT_KEY_COLUMNS,
	PREMIUM_LEDGER_COLUMNS,
	type PremiumExpirationByDayRow,
	type PremiumGrantKeyRow,
	type PremiumLedgerRow,
} from '@app/api/database/types/PremiumLedgerTypes';

export const PremiumLedger = defineTable<PremiumLedgerRow, 'user_id'>({
	name: 'premium_ledger',
	columns: PREMIUM_LEDGER_COLUMNS,
	primaryKey: ['user_id'],
});
export const PremiumExpirationsByDay = defineTable<
	PremiumExpirationByDayRow,
	'day' | 'shard' | 'user_id',
	'day' | 'shard'
>({
	name: 'premium_expirations_by_day',
	columns: PREMIUM_EXPIRATION_BY_DAY_COLUMNS,
	primaryKey: ['day', 'shard', 'user_id'],
	partitionKey: ['day', 'shard'],
});
export const PremiumGrantKeys = defineTable<PremiumGrantKeyRow, 'user_id' | 'grant_key', 'user_id'>({
	name: 'premium_grant_keys',
	columns: PREMIUM_GRANT_KEY_COLUMNS,
	primaryKey: ['user_id', 'grant_key'],
	partitionKey: ['user_id'],
});
