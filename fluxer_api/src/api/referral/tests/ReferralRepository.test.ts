// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID} from '@app/api/BrandedTypes';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {
	REFERRAL_BAND_SHARDS,
	type ReferralRewardRow,
	referralBand,
	referralBandShard,
	referralCheckShard,
	referralCheckSlot,
	referralPendingMonth,
} from '@app/api/database/types/ReferralTypes';
import {ReferralRepository} from '@app/api/referral/ReferralRepository';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';

const DAY_MS = 86_400_000;
const REFERRER = createUserID(1490000000000000100n);
const REFEREE = createUserID(1490000000000000201n);
const REFERRED_AT = new Date('2026-10-01T10:00:00Z');
const DUE_AT = new Date(REFERRED_AT.getTime() + 3 * DAY_MS);

function rewardRow(overrides: Partial<ReferralRewardRow> = {}): ReferralRewardRow {
	return {
		user_id: REFERRER,
		tier_id: 1490000000000000900n,
		reward: JSON.stringify({type: 'offsite', description: 'Steam card'}),
		status: 'granting',
		granted_at: REFERRED_AT,
		delivered_at: null,
		delivered_by: null,
		note: null,
		code: null,
		...overrides,
	};
}

describe('ReferralRepository', () => {
	const executor = new InMemoryCassandraQueryExecutor();
	const repository = new ReferralRepository();

	beforeAll(() => {
		setCassandraQueryExecutorForTesting(executor);
	});

	afterAll(() => {
		setCassandraQueryExecutorForTesting(new InMemoryCassandraQueryExecutor());
	});

	async function record(refereeId = REFEREE, referredAt = REFERRED_AT, regIp = '203.0.113.7') {
		await repository.recordReferral(
			{refereeId, referrerId: REFERRER, referredAt, regIp, riskBlocked: false},
			{dueAt: new Date(referredAt.getTime() + 3 * DAY_MS), ttlSeconds: 17 * 86_400},
		);
	}

	it('insertCodeIfAbsent loses a race', async () => {
		expect(await repository.insertCodeIfAbsent('abcdefgh23', REFERRER, REFERRED_AT)).toBe(true);
		expect(await repository.insertCodeIfAbsent('abcdefgh23', REFEREE, REFERRED_AT)).toBe(false);
		expect(await repository.getCodeOwner('abcdefgh23')).toBe(REFERRER);
		expect(await repository.getCodeOwner('zzzzzzzz22')).toBeNull();
	});

	it('setOwnCode sets the code once and the loser drops the code row it claimed', async () => {
		await repository.insertCodeIfAbsent('aaaaaaaaaa', REFERRER, REFERRED_AT);
		expect(await repository.setOwnCode(REFERRER, 'aaaaaaaaaa')).toBe(true);
		await repository.insertCodeIfAbsent('bbbbbbbbbb', REFERRER, REFERRED_AT);
		expect(await repository.setOwnCode(REFERRER, 'bbbbbbbbbb')).toBe(false);
		expect((await repository.getUserReferral(REFERRER))?.code).toBe('aaaaaaaaaa');
		expect(await repository.getCodeOwner('bbbbbbbbbb')).toBeNull();

		// A referred account already has a row without a code.
		await record();
		await repository.insertCodeIfAbsent('cccccccccc', REFEREE, REFERRED_AT);
		expect(await repository.setOwnCode(REFEREE, 'cccccccccc')).toBe(true);
		expect(await repository.getUserReferral(REFEREE)).toMatchObject({
			code: 'cccccccccc',
			referrer_id: REFERRER,
			state: 'pending',
		});
	});

	it('recordReferral writes mapping, referrer entry, bucket and check in one batch', async () => {
		const batch = vi.spyOn(executor, 'executeBatch');
		await record();
		expect(batch).toHaveBeenCalledTimes(1);
		expect(batch.mock.calls[0]![1]).not.toBe(false);
		expect(batch.mock.calls[0]![0]).toHaveLength(4);
		batch.mockRestore();

		const mapping = await repository.getUserReferral(REFEREE);
		expect(mapping).toMatchObject({
			user_id: REFEREE,
			referrer_id: REFERRER,
			referred_at: REFERRED_AT,
			state: 'pending',
			risk_blocked: false,
		});
		expect(mapping).not.toHaveProperty('reg_ip');
		expect((await repository.listReferrals(REFERRER, null, 10)).items).toEqual([
			{
				referrer_id: REFERRER,
				bucket: Math.floor(REFERRED_AT.getTime() / DAY_MS),
				referee_id: REFEREE,
				referred_at: REFERRED_AT,
				state: 'pending',
				reason: null,
			},
		]);
		expect(await repository.listChecks(referralCheckSlot(DUE_AT), referralCheckShard(REFEREE), 10)).toEqual([
			{
				slot: referralCheckSlot(DUE_AT),
				shard: referralCheckShard(REFEREE),
				referee_id: REFEREE,
				due_at: DUE_AT,
				reg_ip: '203.0.113.7',
			},
		]);
	});

	it('transitionState applies once from pending', async () => {
		await record();
		const decidedAt = new Date(DUE_AT.getTime() + 1000);
		expect(await repository.transitionState(REFEREE, 'valid', null, decidedAt)).toBe(true);
		expect(await repository.transitionState(REFEREE, 'rejected', 'same_ip', decidedAt)).toBe(false);
		expect(await repository.getUserReferral(REFEREE)).toMatchObject({
			state: 'valid',
			reason: null,
			decided_at: decidedAt,
		});
		expect(await repository.transitionState(createUserID(5n), 'valid', null, decidedAt)).toBe(false);

		await repository.updateReferrerEntry(REFERRER, REFERRED_AT, REFEREE, 'valid', null);
		expect((await repository.listReferrals(REFERRER, null, 10)).items[0]).toMatchObject({state: 'valid'});
	});

	it('moves and deletes a check, keeping its IP until it goes', async () => {
		await record();
		const key = {slot: referralCheckSlot(DUE_AT), shard: referralCheckShard(REFEREE), referee_id: REFEREE};
		const later = new Date(DUE_AT.getTime() + DAY_MS);
		const row = await repository.getCheck(key);
		expect(row).toEqual({...key, due_at: DUE_AT, reg_ip: '203.0.113.7'});
		expect(await repository.getCheck({...key, referee_id: createUserID(5n)})).toBeNull();
		await repository.moveCheck(row!, later, 16 * 86_400);
		expect(await repository.listChecks(key.slot, key.shard, 10)).toEqual([]);
		const moved = await repository.listChecks(referralCheckSlot(later), key.shard, 10);
		expect(moved).toEqual([{...key, slot: referralCheckSlot(later), due_at: later, reg_ip: '203.0.113.7'}]);

		// The daily cap moves a row whose IP rules already passed without its IP (V4).
		const evenLater = new Date(later.getTime() + DAY_MS);
		await repository.moveCheck(moved[0]!, evenLater, 16 * 86_400, {dropIp: true});
		expect(await repository.getCheck({...key, slot: referralCheckSlot(evenLater)})).toMatchObject({reg_ip: null});

		await repository.deleteCheck({...key, slot: referralCheckSlot(evenLater)});
		expect(await repository.listChecks(referralCheckSlot(evenLater), key.shard, 10)).toEqual([]);
	});

	it('pages checks within a slot shard by referee', async () => {
		const shard = 3;
		const ids = [16n * 10n + 3n, 16n * 30n + 3n, 16n * 20n + 3n].map((id) => createUserID(id));
		for (const id of ids) await record(id);
		const slot = referralCheckSlot(DUE_AT);
		expect((await repository.listChecks(slot, shard, 2)).map((row) => row.referee_id)).toEqual([163n, 323n]);
		expect((await repository.listChecks(slot, shard, 10, createUserID(323n))).map((row) => row.referee_id)).toEqual([
			483n,
		]);
	});

	it('listReferrals pages across day buckets, newest first', async () => {
		const ids: Array<bigint> = [];
		for (let day = 0; day < 4; day++) {
			for (let n = 0; n < 2; n++) {
				const id = 1490000000000001000n + BigInt(day * 10 + n);
				ids.push(id);
				await record(createUserID(id), new Date(REFERRED_AT.getTime() + day * DAY_MS + n * 1000));
			}
		}
		const seen: Array<bigint> = [];
		let cursor: string | null = null;
		for (let page = 0; page < 10; page++) {
			const result = await repository.listReferrals(REFERRER, cursor, 3);
			seen.push(...result.items.map((row) => row.referee_id));
			cursor = result.nextCursor;
			if (cursor === null) break;
		}
		expect(seen).toEqual([...ids].sort((a, b) => (a < b ? 1 : -1)));
		expect(await repository.listReferrals(REFERRER, 'not-a-cursor', 3)).toEqual({items: [], nextCursor: null});
	});

	it('moves a referrer between bands and pages a band', async () => {
		await repository.setBand(REFERRER, 0, 1);
		const shard = referralBandShard(REFERRER);
		expect((await repository.listBand(0, shard, 10)).map((row) => row.user_id)).toEqual([REFERRER]);
		await repository.setBand(REFERRER, 1, 2);
		expect(await repository.listBand(0, shard, 10)).toEqual([]);
		expect((await repository.listBand(referralBand(2), shard, 10)).map((row) => row.user_id)).toEqual([REFERRER]);
		await repository.setBand(REFERRER, 2, 3);
		expect((await repository.listBand(1, shard, 10)).map((row) => row.user_id)).toEqual([REFERRER]);

		const other = createUserID(REFERRER + BigInt(REFERRAL_BAND_SHARDS));
		await repository.setBand(other, 0, 2);
		expect((await repository.listBand(1, shard, 1)).map((row) => row.user_id)).toEqual([REFERRER]);
		expect((await repository.listBand(1, shard, 10, REFERRER)).map((row) => row.user_id)).toEqual([other]);
	});

	it('writes and reads the stats base', async () => {
		expect(await repository.getStats(REFERRER)).toBeNull();
		await repository.writeStatsField(REFERRER, 'valid_count', 4);
		await repository.writeStatsField(REFERRER, 'pending_count', 2);
		expect(await repository.getStats(REFERRER)).toMatchObject({valid_count: 4n, pending_count: 2n});
	});

	it('claimReward/setRewardStatus are conditional', async () => {
		const row = rewardRow();
		expect(await repository.claimReward(row)).toBe('claimed');
		expect(await repository.claimReward({...row, status: 'auto_delivered'})).toBe('exists');
		expect(await repository.setRewardStatus(REFERRER, row.tier_id, 'pending_admin', {status: 'delivered'})).toBe(false);
		expect(await repository.setRewardStatus(REFERRER, row.tier_id, 'granting', {status: 'pending_admin'})).toBe(true);
		const deliveredAt = new Date(REFERRED_AT.getTime() + DAY_MS);
		expect(
			await repository.setRewardStatus(REFERRER, row.tier_id, 'pending_admin', {
				status: 'delivered',
				delivered_at: deliveredAt,
				delivered_by: createUserID(9n),
				code: 'STEAM-1234',
				note: 'sent',
			}),
		).toBe(true);
		expect(await repository.getRewards(REFERRER)).toEqual([
			{...row, status: 'delivered', delivered_at: deliveredAt, delivered_by: 9n, code: 'STEAM-1234', note: 'sent'},
		]);
	});

	it('pages pending rewards within a month', async () => {
		const month = referralPendingMonth(REFERRED_AT);
		const rows = [0, 1, 2].map((n) => ({
			month,
			created_at: new Date(REFERRED_AT.getTime() + n * 1000),
			user_id: createUserID(100n + BigInt(n)),
			tier_id: 7n,
		}));
		for (const row of rows) await repository.insertPendingReward(row);
		const first = await repository.listPendingRewards(month, null, 2);
		expect(first.items).toEqual(rows.slice(0, 2));
		expect(first.nextCursor).not.toBeNull();
		const second = await repository.listPendingRewards(month, first.nextCursor, 2);
		expect(second).toEqual({items: rows.slice(2), nextCursor: null});
		await repository.deletePendingReward(rows[0]!);
		expect((await repository.listPendingRewards(month, null, 10)).items).toEqual(rows.slice(1));
		expect(await repository.listPendingRewards('2026-11', null, 10)).toEqual({items: [], nextCursor: null});
	});

	it('deleteAllForUser removes own rows and band rows, and keeps the entry in the referrer list', async () => {
		// REFERRER was referred by someone and referred REFEREE.
		const grand = createUserID(1490000000000000050n);
		await repository.recordReferral(
			{refereeId: REFERRER, referrerId: grand, referredAt: REFERRED_AT, regIp: '198.51.100.1', riskBlocked: false},
			{dueAt: DUE_AT, ttlSeconds: 17 * 86_400},
		);
		await record();
		await repository.insertCodeIfAbsent('dddddddddd', REFERRER, REFERRED_AT);
		await repository.setOwnCode(REFERRER, 'dddddddddd');
		await repository.writeStatsField(REFERRER, 'valid_count', 9);
		await repository.setBand(REFERRER, 0, 9);
		await repository.claimReward(rewardRow({status: 'pending_admin'}));
		await repository.insertPendingReward({
			month: referralPendingMonth(REFERRED_AT),
			created_at: REFERRED_AT,
			user_id: REFERRER,
			tier_id: 1490000000000000900n,
		});

		await repository.deleteAllForUser(REFERRER);
		await repository.deleteAllForUser(REFERRER);

		expect(await repository.getUserReferral(REFERRER)).toBeNull();
		expect(await repository.getCodeOwner('dddddddddd')).toBeNull();
		expect(await repository.getStats(REFERRER)).toBeNull();
		expect(await repository.getRewards(REFERRER)).toEqual([]);
		expect((await repository.listPendingRewards(referralPendingMonth(REFERRED_AT), null, 10)).items).toEqual([]);
		expect(await repository.listBand(referralBand(9), referralBandShard(REFERRER), 10)).toEqual([]);
		expect(await repository.listReferrals(REFERRER, null, 10)).toEqual({items: [], nextCursor: null});
		// the entry in the referrer's list stays (an ID only).
		expect((await repository.listReferrals(grand, null, 10)).items.map((row) => row.referee_id)).toEqual([REFERRER]);
		// The referee's own mapping is theirs, not the deleted referrer's.
		expect(await repository.getUserReferral(REFEREE)).not.toBeNull();
	});

	it('harvest has no reg_ip and no off-site code text', async () => {
		await repository.recordReferral(
			{
				refereeId: REFERRER,
				referrerId: createUserID(50n),
				referredAt: REFERRED_AT,
				regIp: '198.51.100.1',
				riskBlocked: true,
			},
			{dueAt: DUE_AT, ttlSeconds: 17 * 86_400},
		);
		await repository.insertCodeIfAbsent('eeeeeeeeee', REFERRER, REFERRED_AT);
		await repository.setOwnCode(REFERRER, 'eeeeeeeeee');
		await repository.writeStatsField(REFERRER, 'valid_count', 2);
		await repository.claimReward(rewardRow({status: 'delivered', code: 'SECRET-CODE-1', delivered_at: DUE_AT}));

		const harvest = await repository.harvest(REFERRER);
		const text = JSON.stringify(harvest);
		expect(text).not.toContain('198.51.100.1');
		expect(text).not.toContain('reg_ip');
		expect(text).not.toContain('SECRET-CODE-1');
		expect(harvest).toEqual({
			code: 'eeeeeeeeee',
			referrer_id: '50',
			referred_at: REFERRED_AT.toISOString(),
			state: 'pending',
			reason: null,
			counts: {valid: 2, pending: 0, rejected: 0},
			rewards: [
				{
					tier_id: '1490000000000000900',
					reward: {type: 'offsite', description: 'Steam card'},
					status: 'delivered',
					granted_at: REFERRED_AT.toISOString(),
					delivered_at: DUE_AT.toISOString(),
					has_code: true,
				},
			],
		});
		expect(await repository.harvest(createUserID(77n))).toEqual({
			code: null,
			referrer_id: null,
			referred_at: null,
			state: null,
			reason: null,
			counts: {valid: 0, pending: 0, rejected: 0},
			rewards: [],
		});
	});
});
