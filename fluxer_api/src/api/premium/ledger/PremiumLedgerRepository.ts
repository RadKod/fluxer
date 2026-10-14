// SPDX-License-Identifier: AGPL-3.0-or-later

import type {GuildID, UserID} from '@app/api/BrandedTypes';
import {
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db} from '@app/api/database/CassandraTypes';
import type {
	PremiumExpirationByDayRow,
	PremiumGrantKeyRow,
	PremiumLedgerRow,
} from '@app/api/database/types/PremiumLedgerTypes';
import {PremiumExpirationsByDay, PremiumGrantKeys, PremiumLedger} from '@app/api/premium/ledger/PremiumLedgerTables';
import {GuildMembers} from '@app/api/Tables';

const MAX_ANONYMIZE_ATTEMPTS = 5;
const FETCH_LEDGER_CQL = PremiumLedger.selectCql({where: PremiumLedger.where.eq('user_id'), limit: 1});
const FETCH_PAID_UNTIL_CQL = PremiumLedger.selectCql({
	columns: ['paid_until'],
	where: PremiumLedger.where.eq('user_id'),
	limit: 1,
});
const FETCH_GRANT_KEY_CQL = PremiumGrantKeys.selectCql({
	where: [PremiumGrantKeys.where.eq('user_id'), PremiumGrantKeys.where.eq('grant_key')],
	limit: 1,
});

function createExpirationsFirstPageQuery(limit: number) {
	return PremiumExpirationsByDay.select({
		where: [PremiumExpirationsByDay.where.eq('day'), PremiumExpirationsByDay.where.eq('shard')],
		limit,
	});
}

function createExpirationsPageQuery(limit: number) {
	return PremiumExpirationsByDay.select({
		where: [
			PremiumExpirationsByDay.where.eq('day'),
			PremiumExpirationsByDay.where.eq('shard'),
			PremiumExpirationsByDay.where.gt('user_id'),
		],
		limit,
	});
}

export type PremiumLedgerUpdate = Pick<PremiumLedgerRow, 'paid_until' | 'applied_grants' | 'trial_used_at'>;

export class PremiumLedgerRepository {
	async find(userId: UserID): Promise<PremiumLedgerRow | null> {
		return fetchOne<PremiumLedgerRow>(FETCH_LEDGER_CQL, {user_id: userId});
	}

	async findPaidUntil(userId: UserID): Promise<Date | null> {
		const row = await fetchOne<Pick<PremiumLedgerRow, 'paid_until'>>(FETCH_PAID_UNTIL_CQL, {user_id: userId});
		return row?.paid_until ?? null;
	}

	async create(row: PremiumLedgerRow): Promise<boolean> {
		return executeConditional(PremiumLedger.insertIfNotExists(row));
	}

	async update(userId: UserID, update: PremiumLedgerUpdate, expectedVersion: number): Promise<boolean> {
		return executeConditional(
			PremiumLedger.conditionalPatchByPk(
				{user_id: userId},
				{
					paid_until: update.paid_until ? Db.set(update.paid_until) : Db.clear(),
					applied_grants: update.applied_grants?.size ? Db.set(update.applied_grants) : Db.clear(),
					trial_used_at: update.trial_used_at ? Db.set(update.trial_used_at) : Db.clear(),
					version: Db.set(expectedVersion + 1),
				},
				{version: expectedVersion},
			),
		);
	}

	async findGrantKey(userId: UserID, grantKey: string): Promise<PremiumGrantKeyRow | null> {
		return fetchOne<PremiumGrantKeyRow>(FETCH_GRANT_KEY_CQL, {user_id: userId, grant_key: grantKey});
	}

	async claimGrantKey(row: PremiumGrantKeyRow): Promise<boolean> {
		return executeConditional(PremiumGrantKeys.insertIfNotExists(row));
	}

	async markGrantKeyDelivered(userId: UserID, grantKey: string, at: Date): Promise<boolean> {
		return executeConditional(
			PremiumGrantKeys.conditionalPatchByPk(
				{user_id: userId, grant_key: grantKey},
				{state: Db.set('delivered'), delivered_at: Db.set(at)},
				{state: 'pending'},
			),
		);
	}

	// Account deletion ends the paid period and forgets the trial, but keeps the applied grant keys (payment order
	// references, which the payment records keep anyway): a delivery retried after the deletion must still find its
	// grant applied instead of putting premium back on the deleted account.
	async anonymizeForDeletion(userId: UserID, at: Date): Promise<void> {
		for (let attempt = 0; attempt < MAX_ANONYMIZE_ATTEMPTS; attempt++) {
			const row = await this.find(userId);
			if (!row) return;
			const paidUntil = row.paid_until && row.paid_until < at ? row.paid_until : at;
			const update = {paid_until: paidUntil, applied_grants: row.applied_grants, trial_used_at: null};
			if (await this.update(userId, update, row.version)) return;
		}
		throw new Error('Premium ledger kept changing while its user was being deleted');
	}

	async addExpiration(row: PremiumExpirationByDayRow, ttlSeconds: number): Promise<void> {
		await upsertOne(PremiumExpirationsByDay.insertWithTtl(row, ttlSeconds));
	}

	async listExpirations(
		day: number,
		shard: number,
		limit: number,
		afterUserId?: UserID,
	): Promise<Array<PremiumExpirationByDayRow>> {
		if (afterUserId === undefined) {
			return fetchMany<PremiumExpirationByDayRow>(createExpirationsFirstPageQuery(limit).bind({day, shard}));
		}
		return fetchMany<PremiumExpirationByDayRow>(
			createExpirationsPageQuery(limit).bind({day, shard, user_id: afterUserId}),
		);
	}

	async deleteExpiration(row: PremiumExpirationByDayRow): Promise<void> {
		await deleteOneOrMany(PremiumExpirationsByDay.deleteByPk(row));
	}

	async clearMemberPremiumSanitization(guildId: GuildID, userId: UserID): Promise<boolean> {
		return executeConditional(
			GuildMembers.conditionalPatchByPk(
				{guild_id: guildId, user_id: userId},
				{is_premium_sanitized: Db.set(false)},
				{is_premium_sanitized: true},
			),
		);
	}
}
