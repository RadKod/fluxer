// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {PioneerByUser, PioneerSlots, PioneerState} from '@app/api/badge/BadgeTables';
import {
	executeConditional,
	executeQuery,
	fetchMany,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {Db, type PreparedQuery} from '@app/api/database/CassandraTypes';
import type {
	PioneerByUserRow,
	PioneerSlotRow,
	PioneerStateRow,
	PioneerStatus,
	PioneerUserStatus,
} from '@app/api/database/types/BadgeTypes';

const STATE_ID = 0;
const SERIAL = {consistency: 'serial'} as const;
const FETCH_STATE_CQL = PioneerState.select({where: PioneerState.where.eq('id'), limit: 1});
const FETCH_BY_USER_CQL = PioneerByUser.select({where: PioneerByUser.where.eq('user_id'), limit: 1});
const FETCH_SLOT_CQL = PioneerSlots.select({where: PioneerSlots.where.eq('slot'), limit: 1});

// A lost Cassandra LWT answers with the row that won, so the caller needs no second read. The test and Postgres-KV
// executors answer only [applied]; then `existing` is null and the caller reads with SERIAL.
async function insertOrExisting<T>(query: PreparedQuery): Promise<{applied: boolean; existing: T | null}> {
	const [row] = await executeQuery<Record<string, unknown>>(query);
	const applied = row?.['[applied]'];
	if (typeof applied !== 'boolean') throw new Error('Unexpected database response for a conditional insert');
	return {applied, existing: !applied && row && Object.keys(row).length > 1 ? (row as T) : null};
}

// Micup Öncü. Every status write is a compare-and-set (LWT); next_slot is a plain write and never part of a condition.
// Every insert names every column (null included): a missing column is not written at all.
export class PioneerRepository {
	async getState(): Promise<PioneerStateRow | null> {
		return fetchOne<PioneerStateRow>(FETCH_STATE_CQL.bind({id: STATE_ID}));
	}

	async ensureState(): Promise<PioneerStateRow> {
		await executeConditional(
			PioneerState.insertIfNotExists({
				id: STATE_ID,
				badge_id: null,
				status: 'off',
				next_slot: 1,
				updated_at: new Date(),
			}),
		);
		const state = await this.getState();
		if (!state) throw new Error('pioneer_state row is missing after its insert');
		return state;
	}

	async setStatus(expected: PioneerStatus, next: PioneerStatus, badgeId?: bigint): Promise<boolean> {
		return executeConditional(
			PioneerState.conditionalPatchByPk(
				{id: STATE_ID},
				{
					status: Db.set(next),
					updated_at: Db.set(new Date()),
					...(badgeId === undefined ? {} : {badge_id: Db.set(badgeId)}),
				},
				{status: expected},
			),
		);
	}

	// TEMPORARY: only where a new claim starts probing; a lost or stale write costs extra probes, never a duplicate.
	async setNextSlot(slot: number): Promise<void> {
		await upsertOne(PioneerState.patchByPk({id: STATE_ID}, {next_slot: Db.set(slot)}));
	}

	async getByUser(userId: UserID, serial = false): Promise<PioneerByUserRow | null> {
		const [row] = await fetchMany<PioneerByUserRow>(
			FETCH_BY_USER_CQL.bind({user_id: userId}),
			undefined,
			serial ? SERIAL : undefined,
		);
		return row ?? null;
	}

	async claimUser(row: PioneerByUserRow): Promise<{applied: boolean; existing: PioneerByUserRow | null}> {
		return insertOrExisting<PioneerByUserRow>(PioneerByUser.insertIfNotExists(row));
	}

	// slot: undefined leaves it, null clears it.
	async setUserStatus(
		userId: UserID,
		expected: PioneerUserStatus,
		next: PioneerUserStatus,
		slot?: number | null,
	): Promise<boolean> {
		return executeConditional(
			PioneerByUser.conditionalPatchByPk(
				{user_id: userId},
				{
					status: Db.set(next),
					updated_at: Db.set(new Date()),
					...(slot === undefined ? {} : {slot: slot === null ? Db.clear() : Db.set(slot)}),
				},
				{status: expected},
			),
		);
	}

	async claimSlot(slot: number, userId: UserID): Promise<{applied: boolean; existing: PioneerSlotRow | null}> {
		return insertOrExisting<PioneerSlotRow>(
			PioneerSlots.insertIfNotExists({slot, user_id: userId, assigned_at: new Date()}),
		);
	}

	// SERIAL: after a lost claim this sees the committed holder, so a retry recognises its own slot.
	async getSlot(slot: number): Promise<PioneerSlotRow | null> {
		const [row] = await fetchMany<PioneerSlotRow>(FETCH_SLOT_CQL.bind({slot}), undefined, SERIAL);
		return row ?? null;
	}

	async clearSlotUser(slot: number, userId: UserID): Promise<boolean> {
		return executeConditional(PioneerSlots.conditionalPatchByPk({slot}, {user_id: Db.clear()}, {user_id: userId}));
	}
}
