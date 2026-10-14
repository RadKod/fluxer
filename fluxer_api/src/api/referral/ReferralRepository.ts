// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import {
	BatchBuilder,
	deleteOneOrMany,
	executeConditional,
	fetchMany,
	fetchOne,
	upsertOne,
} from '@app/api/database/CassandraQueryExecution';
import {type CassandraParams, Db, type DbOp} from '@app/api/database/CassandraTypes';
import {
	REFERRAL_MAX_BAND,
	type ReferralByReferrerRow,
	type ReferralCheckRow,
	type ReferralCodeRow,
	type ReferralPendingRewardRow,
	type ReferralRewardRow,
	type ReferralState,
	type ReferralStatsRow,
	type ReferrerByBandRow,
	referralBand,
	referralBandShard,
	referralCheckShard,
	referralCheckSlot,
	referralDayBucket,
	referralPendingMonth,
	type UserReferralRow,
} from '@app/api/database/types/ReferralTypes';
import {
	ReferralBucketsByReferrer,
	ReferralChecks,
	ReferralCodes,
	ReferralPendingRewards,
	ReferralRewards,
	ReferralStats,
	ReferralsByReferrer,
	ReferrersByBand,
	UserReferrals,
} from '@app/api/referral/ReferralTables';
import type {
	ReferralRejectReason,
	ReferralRewardStatus,
} from '@fluxer/schema/src/domains/referral/ReferralResponseSchemas';

const MAX_BUCKET = 2_147_483_647;
const NO_BEFORE = (1n << 63n) - 1n;
const NO_AFTER = 0n;
const BUCKET_LIST_PAGE = 32;
// A page may stop short after this many non-empty day buckets; its nextCursor carries on from there.
const MAX_FILLED_BUCKETS_PER_PAGE = 16;

type CheckKey = Pick<ReferralCheckRow, 'slot' | 'shard' | 'referee_id'>;
type PendingRewardKey = Pick<ReferralPendingRewardRow, 'month' | 'created_at' | 'user_id' | 'tier_id'>;
export type ReferralStatsField = 'valid_count' | 'pending_count' | 'rejected_count';
export type ReferralRewardPatch = Partial<
	Pick<ReferralRewardRow, 'status' | 'delivered_at' | 'delivered_by' | 'note' | 'code'>
>;

export interface NewReferral {
	refereeId: UserID;
	referrerId: UserID;
	referredAt: Date;
	regIp: string;
	riskBlocked: boolean;
}

// The data export of one account: no registration IP and no off-site code text.
export interface ReferralHarvest {
	code: string | null;
	referrer_id: string | null;
	referred_at: string | null;
	state: ReferralState | null;
	reason: ReferralRejectReason | null;
	counts: {valid: number; pending: number; rejected: number};
	rewards: Array<{
		tier_id: string;
		reward: unknown;
		status: ReferralRewardStatus;
		granted_at: string;
		delivered_at: string | null;
		has_code: boolean;
	}>;
}

const FETCH_CODE_CQL = ReferralCodes.selectCql({where: ReferralCodes.where.eq('code'), limit: 1});
const FETCH_USER_REFERRAL_CQL = UserReferrals.selectCql({where: UserReferrals.where.eq('user_id'), limit: 1});
const FETCH_CHECK_CQL = ReferralChecks.selectCql({
	where: [ReferralChecks.where.eq('slot'), ReferralChecks.where.eq('shard'), ReferralChecks.where.eq('referee_id')],
	limit: 1,
});
const FETCH_BUCKETS_CQL = ReferralBucketsByReferrer.selectCql({
	columns: ['bucket'],
	where: [
		ReferralBucketsByReferrer.where.eq('referrer_id'),
		ReferralBucketsByReferrer.where.lte('bucket', 'from_bucket'),
	],
	orderBy: {col: 'bucket', direction: 'DESC'},
	limit: BUCKET_LIST_PAGE,
});
const FETCH_STATS_CQL = ReferralStats.selectCql({where: ReferralStats.where.eq('user_id'), limit: 1});
const LIST_REWARDS_CQL = ReferralRewards.selectCql({where: ReferralRewards.where.eq('user_id')});

function referralsPageQuery(limit: number) {
	return ReferralsByReferrer.select({
		where: [
			ReferralsByReferrer.where.eq('referrer_id'),
			ReferralsByReferrer.where.eq('bucket'),
			ReferralsByReferrer.where.lt('referee_id', 'before'),
		],
		orderBy: {col: 'referee_id', direction: 'DESC'},
		limit,
	});
}

function checksQuery(limit: number) {
	return ReferralChecks.select({
		where: [
			ReferralChecks.where.eq('slot'),
			ReferralChecks.where.eq('shard'),
			ReferralChecks.where.gt('referee_id', 'after'),
		],
		orderBy: {col: 'referee_id', direction: 'ASC'},
		limit,
	});
}

function bandQuery(limit: number) {
	return ReferrersByBand.select({
		where: [
			ReferrersByBand.where.eq('band'),
			ReferrersByBand.where.eq('shard'),
			ReferrersByBand.where.gt('user_id', 'after'),
		],
		orderBy: {col: 'user_id', direction: 'ASC'},
		limit,
	});
}

function pendingRewardsQuery(limit: number, afterCursor: boolean) {
	const month = ReferralPendingRewards.where.eq('month');
	return ReferralPendingRewards.select({
		where: afterCursor
			? [
					month,
					ReferralPendingRewards.where.tupleGt(
						['created_at', 'user_id', 'tier_id'],
						['after_at', 'after_user', 'after_tier'],
					),
				]
			: [month],
		orderBy: {col: 'created_at', direction: 'ASC'},
		limit,
	});
}

// Cursors are opaque to callers; a malformed one reads as an empty last page.
function parseCursor(cursor: string, parts: number): Array<bigint> | null {
	const pieces = cursor.split(':');
	if (pieces.length !== parts || !pieces.every((piece) => /^\d{1,19}$/.test(piece))) return null;
	return pieces.map(BigInt);
}

// Referral tables: codes, mappings, referrer lists, the evaluation schedule, stats bases, rewards and
// referrer bands.
export class ReferralRepository {
	async getCodeOwner(code: string): Promise<UserID | null> {
		return (await fetchOne<ReferralCodeRow>(FETCH_CODE_CQL, {code}))?.user_id ?? null;
	}

	/** Whether this call claimed the code (LWT), so two accounts never share one. */
	async insertCodeIfAbsent(code: string, userId: UserID, now: Date): Promise<boolean> {
		return executeConditional(ReferralCodes.insertIfNotExists({code, user_id: userId, created_at: now}));
	}

	async getUserReferral(userId: UserID): Promise<UserReferralRow | null> {
		return fetchOne<UserReferralRow>(FETCH_USER_REFERRAL_CQL, {user_id: userId});
	}

	/**
	 * Sets the account's own code once. The caller has just claimed `code` with insertCodeIfAbsent; when a
	 * racing call set another code first, this one drops the code row it claimed and returns false.
	 */
	async setOwnCode(userId: UserID, code: string): Promise<boolean> {
		if (await this.claimOwnCode(userId, code)) return true;
		await executeConditional(ReferralCodes.conditionalDeleteByPk({code}, {user_id: userId}));
		return false;
	}

	// LWT IF code = null: the DSL refuses an all-null IF, so the condition also pins referrer_id. An existing row without
	// a code is a referred account's mapping, whose referrer_id never changes.
	private async claimOwnCode(userId: UserID, code: string): Promise<boolean> {
		const created = await executeConditional(
			UserReferrals.insertIfNotExists({
				user_id: userId,
				code,
				referrer_id: null,
				referred_at: null,
				state: null,
				reason: null,
				risk_blocked: null,
				decided_at: null,
			}),
		);
		if (created) return true;
		const row = await this.getUserReferral(userId);
		if (!row?.referrer_id || row.code) return false;
		return executeConditional(
			UserReferrals.conditionalPatchByPk(
				{user_id: userId},
				{code: Db.set<string | null>(code)},
				{code: null, referrer_id: row.referrer_id},
			),
		);
	}

	/** The mapping, the referrer's list entry, its day bucket and the evaluation row (with the IP) in one logged batch. */
	async recordReferral(referral: NewReferral, check: {dueAt: Date; ttlSeconds: number}): Promise<void> {
		const {refereeId, referrerId, referredAt, regIp, riskBlocked} = referral;
		const bucket = referralDayBucket(referredAt);
		await new BatchBuilder()
			.addPrepared(
				UserReferrals.patchByPk(
					{user_id: refereeId},
					{
						referrer_id: Db.set<UserID | null>(referrerId),
						referred_at: Db.set<Date | null>(referredAt),
						state: Db.set<ReferralState | null>('pending'),
						risk_blocked: Db.set<boolean | null>(riskBlocked),
					},
				),
			)
			.addPrepared(
				ReferralsByReferrer.upsertAll({
					referrer_id: referrerId,
					bucket,
					referee_id: refereeId,
					referred_at: referredAt,
					state: 'pending',
					reason: null,
				}),
			)
			.addPrepared(ReferralBucketsByReferrer.upsertAll({referrer_id: referrerId, bucket}))
			.addPrepared(
				ReferralChecks.insertWithTtl(
					{
						slot: referralCheckSlot(check.dueAt),
						shard: referralCheckShard(refereeId),
						referee_id: refereeId,
						due_at: check.dueAt,
						reg_ip: regIp,
					},
					check.ttlSeconds,
				),
			)
			.execute();
	}

	/** Whether this call decided the referral (LWT IF state = 'pending'), so a decision counts once. */
	async transitionState(
		refereeId: UserID,
		to: Exclude<ReferralState, 'pending'>,
		reason: ReferralRejectReason | null,
		decidedAt: Date,
	): Promise<boolean> {
		return executeConditional(
			UserReferrals.conditionalPatchByPk(
				{user_id: refereeId},
				{
					state: Db.set<ReferralState | null>(to),
					reason: Db.set(reason),
					decided_at: Db.set<Date | null>(decidedAt),
				},
				{state: 'pending'},
			),
		);
	}

	async updateReferrerEntry(
		referrerId: UserID,
		referredAt: Date,
		refereeId: UserID,
		state: ReferralState,
		reason: ReferralRejectReason | null,
	): Promise<void> {
		await upsertOne(
			ReferralsByReferrer.patchByPk(
				{referrer_id: referrerId, bucket: referralDayBucket(referredAt), referee_id: refereeId},
				{state: Db.set(state), reason: Db.set(reason)},
			),
		);
	}

	/** One page of a referrer's referrals, newest day first. A null nextCursor ends the list. */
	async listReferrals(
		referrerId: UserID,
		cursor: string | null,
		limit: number,
	): Promise<{items: Array<ReferralByReferrerRow>; nextCursor: string | null}> {
		let fromBucket = MAX_BUCKET;
		let before = NO_BEFORE;
		if (cursor) {
			const parsed = parseCursor(cursor, 2);
			if (!parsed || parsed[0]! > BigInt(MAX_BUCKET)) return {items: [], nextCursor: null};
			fromBucket = Number(parsed[0]);
			before = parsed[1]!;
		}
		const items: Array<ReferralByReferrerRow> = [];
		const cursorAt = (row: ReferralByReferrerRow) => `${row.bucket}:${row.referee_id}`;
		let filledBuckets = 0;
		for (;;) {
			const buckets = await fetchMany<{bucket: number}>(FETCH_BUCKETS_CQL, {
				referrer_id: referrerId,
				from_bucket: fromBucket,
			});
			for (const {bucket} of buckets) {
				const page = await fetchMany<ReferralByReferrerRow>(
					referralsPageQuery(limit + 1 - items.length).bind({referrer_id: referrerId, bucket, before}),
				);
				items.push(...page);
				if (items.length > limit) return {items: items.slice(0, limit), nextCursor: cursorAt(items[limit - 1]!)};
				if (page.length > 0 && ++filledBuckets >= MAX_FILLED_BUCKETS_PER_PAGE) {
					return {items, nextCursor: cursorAt(items.at(-1)!)};
				}
				before = NO_BEFORE;
			}
			if (buckets.length < BUCKET_LIST_PAGE) return {items, nextCursor: null};
			fromBucket = buckets.at(-1)!.bucket - 1;
		}
	}

	async listChecks(slot: number, shard: number, limit: number, after?: UserID): Promise<Array<ReferralCheckRow>> {
		return fetchMany<ReferralCheckRow>(checksQuery(limit).bind({slot, shard, after: after ?? NO_AFTER}));
	}

	/** Deleting the row also deletes the registration IP it carries. */
	async deleteCheck(key: CheckKey): Promise<void> {
		await deleteOneOrMany(ReferralChecks.deleteByPk({slot: key.slot, shard: key.shard, referee_id: key.referee_id}));
	}

	async getCheck(key: CheckKey): Promise<ReferralCheckRow | null> {
		return fetchOne<ReferralCheckRow>(FETCH_CHECK_CQL, {slot: key.slot, shard: key.shard, referee_id: key.referee_id});
	}

	/** Moves a check row the caller read to `dueAt`, IP included unless `dropIp` (V4: its IP rules already passed). */
	async moveCheck(row: ReferralCheckRow, dueAt: Date, ttlSeconds: number, options?: {dropIp?: boolean}): Promise<void> {
		const slot = referralCheckSlot(dueAt);
		const regIp = options?.dropIp ? null : row.reg_ip;
		await new BatchBuilder()
			.addPreparedIf(
				slot !== row.slot,
				ReferralChecks.deleteByPk({slot: row.slot, shard: row.shard, referee_id: row.referee_id}),
			)
			.addPrepared(ReferralChecks.insertWithTtl({...row, slot, due_at: dueAt, reg_ip: regIp}, ttlSeconds))
			.execute();
	}

	/** Moves the referrer to the band of `count` (floor(log2)); no row below 1. */
	async setBand(userId: UserID, prevCount: number, count: number): Promise<void> {
		const prev = prevCount >= 1 ? referralBand(prevCount) : null;
		const next = count >= 1 ? referralBand(count) : null;
		if (prev === next) return;
		const shard = referralBandShard(userId);
		await new BatchBuilder()
			.addPreparedIf(prev !== null, ReferrersByBand.deleteByPk({band: prev ?? 0, shard, user_id: userId}))
			.addPreparedIf(next !== null, ReferrersByBand.upsertAll({band: next ?? 0, shard, user_id: userId}))
			.execute();
	}

	async listBand(band: number, shard: number, limit: number, after?: UserID): Promise<Array<ReferrerByBandRow>> {
		return fetchMany<ReferrerByBandRow>(bandQuery(limit).bind({band, shard, after: after ?? NO_AFTER}));
	}

	async getStats(userId: UserID): Promise<ReferralStatsRow | null> {
		return fetchOne<ReferralStatsRow>(FETCH_STATS_CQL, {user_id: userId});
	}

	async writeStatsField(userId: UserID, field: ReferralStatsField, value: number): Promise<void> {
		await upsertOne(
			ReferralStats.patchByPk({user_id: userId}, {[field]: Db.set<bigint | null>(BigInt(Math.max(0, value)))}),
		);
	}

	// One partition, bounded by the tier count (at most 50).
	async getRewards(userId: UserID): Promise<Array<ReferralRewardRow>> {
		return fetchMany<ReferralRewardRow>(LIST_REWARDS_CQL, {user_id: userId});
	}

	async claimReward(row: ReferralRewardRow): Promise<'claimed' | 'exists'> {
		return (await executeConditional(ReferralRewards.insertIfNotExists(row))) ? 'claimed' : 'exists';
	}

	/** LWT IF status = expected. */
	async setRewardStatus(
		userId: UserID,
		tierId: bigint,
		expected: ReferralRewardStatus,
		patch: ReferralRewardPatch,
	): Promise<boolean> {
		const ops: Record<string, DbOp<unknown>> = {};
		for (const [column, value] of Object.entries(patch)) ops[column] = Db.set(value);
		return executeConditional(
			ReferralRewards.conditionalPatchByPk({user_id: userId, tier_id: tierId}, ops, {status: expected}),
		);
	}

	async insertPendingReward(row: ReferralPendingRewardRow): Promise<void> {
		await upsertOne(ReferralPendingRewards.upsertAll(row));
	}

	async deletePendingReward(key: PendingRewardKey): Promise<void> {
		await deleteOneOrMany(
			ReferralPendingRewards.deleteByPk({
				month: key.month,
				created_at: key.created_at,
				user_id: key.user_id,
				tier_id: key.tier_id,
			}),
		);
	}

	/** One month partition, oldest first. A null nextCursor ends the list. */
	async listPendingRewards(
		month: string,
		cursor: string | null,
		limit: number,
	): Promise<{items: Array<ReferralPendingRewardRow>; nextCursor: string | null}> {
		const after = cursor ? parseCursor(cursor, 3) : null;
		if (cursor && !after) return {items: [], nextCursor: null};
		const params: CassandraParams = after
			? {month, after_at: new Date(Number(after[0])), after_user: after[1]!, after_tier: after[2]!}
			: {month};
		const rows = await fetchMany<ReferralPendingRewardRow>(pendingRewardsQuery(limit + 1, after !== null).bind(params));
		if (rows.length <= limit) return {items: rows, nextCursor: null};
		const last = rows[limit - 1]!;
		return {items: rows.slice(0, limit), nextCursor: `${last.created_at.getTime()}:${last.user_id}:${last.tier_id}`};
	}

	/**
	 * Account deletion: the account's own code, mapping, stats, rewards with their pending rows, band rows
	 * and its own referral list. The entry in its referrer's list stays (an ID only); its evaluation row is deleted when
	 * next evaluated, or by its TTL, since the row's slot is not stored. Idempotent.
	 */
	async deleteAllForUser(userId: UserID): Promise<void> {
		const [mapping, rewards] = await Promise.all([this.getUserReferral(userId), this.getRewards(userId)]);
		if (mapping?.code) {
			await executeConditional(ReferralCodes.conditionalDeleteByPk({code: mapping.code}, {user_id: userId}));
		}
		// Every reward, not only pending_admin ones: a delivery that stopped before its pending row went leaves it behind.
		for (const reward of rewards) {
			await this.deletePendingReward({
				month: referralPendingMonth(reward.granted_at),
				created_at: reward.granted_at,
				user_id: userId,
				tier_id: reward.tier_id,
			});
		}
		const shard = referralBandShard(userId);
		const bands = new BatchBuilder();
		for (let band = 0; band <= REFERRAL_MAX_BAND; band++) {
			bands.addPrepared(ReferrersByBand.deleteByPk({band, shard, user_id: userId}));
		}
		await bands.execute(false);
		let fromBucket = MAX_BUCKET;
		for (;;) {
			const buckets = await fetchMany<{bucket: number}>(FETCH_BUCKETS_CQL, {
				referrer_id: userId,
				from_bucket: fromBucket,
			});
			for (const {bucket} of buckets) {
				await deleteOneOrMany(ReferralsByReferrer.deletePartition({referrer_id: userId, bucket}));
			}
			if (buckets.length < BUCKET_LIST_PAGE) break;
			fromBucket = buckets.at(-1)!.bucket - 1;
		}
		await new BatchBuilder()
			.addPrepared(ReferralBucketsByReferrer.deletePartition({referrer_id: userId}))
			.addPrepared(ReferralRewards.deletePartition({user_id: userId}))
			.addPrepared(ReferralStats.deleteByPk({user_id: userId}))
			.addPrepared(UserReferrals.deleteByPk({user_id: userId}))
			.execute(false);
	}

	async harvest(userId: UserID): Promise<ReferralHarvest> {
		const [mapping, stats, rewards] = await Promise.all([
			this.getUserReferral(userId),
			this.getStats(userId),
			this.getRewards(userId),
		]);
		return {
			code: mapping?.code ?? null,
			referrer_id: mapping?.referrer_id?.toString() ?? null,
			referred_at: mapping?.referred_at?.toISOString() ?? null,
			state: mapping?.state ?? null,
			reason: mapping?.reason ?? null,
			counts: {
				valid: Number(stats?.valid_count ?? 0n),
				pending: Number(stats?.pending_count ?? 0n),
				rejected: Number(stats?.rejected_count ?? 0n),
			},
			rewards: rewards.map((reward) => ({
				tier_id: reward.tier_id.toString(),
				reward: JSON.parse(reward.reward) as unknown,
				status: reward.status,
				granted_at: reward.granted_at.toISOString(),
				delivered_at: reward.delivered_at?.toISOString() ?? null,
				has_code: reward.code !== null,
			})),
		};
	}
}
