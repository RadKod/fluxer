// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import {createUserID, type UserID} from '@app/api/BrandedTypes';
import type {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import {
	REFERRAL_BAND_SHARDS,
	REFERRAL_CHECK_SHARDS,
	REFERRAL_CHECK_SLOT_MS,
	REFERRAL_DECISION_WINDOW_DAYS,
	REFERRAL_MAX_BAND,
	REFERRAL_PENDING_COUNTER,
	REFERRAL_REJECTED_COUNTER,
	REFERRAL_VALID_COUNTER,
	type ReferralCheckRow,
	type ReferralRewardRow,
	referralBand,
	referralCheckSlot,
	referralPendingMonth,
	type UserReferralRow,
} from '@app/api/database/types/ReferralTypes';
import type {KVCounterService} from '@app/api/infrastructure/KVCounterService';
import {
	type InstanceConfigRepository,
	REGISTRATION_PENDING_APPROVAL_TRAIT,
	type ReferralConfig,
} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import type {User} from '@app/api/models/User';
import type {PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import type {ReferralRepository} from '@app/api/referral/ReferralRepository';
import {
	capDeferDays,
	decideReferral,
	dueTiers,
	isReferralAccountBanned,
	isReferralAccountGone,
	referralIpKey,
	sameEmailBase,
} from '@app/api/referral/ReferralRules';
import type {IRegistrationEventsRepository} from '@app/api/risk/adapters/VelocityAdapter';
import {isMicupAccountLimited} from '@app/api/user/AccountLimit';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {MS_PER_DAY, SECONDS_PER_DAY} from '@fluxer/date_utils/src/DateConstants';
import {getSubnet} from '@fluxer/ip_utils/src/IpAddress';
import type {ReferralTierReward} from '@fluxer/schema/src/domains/referral/ReferralRequestSchemas';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

export interface ReferralRewardServiceDeps {
	repository: ReferralRepository;
	instanceConfigRepository: InstanceConfigRepository;
	kvCounterService: KVCounterService;
	kvClient: IKVProvider;
	userRepository: UserRepository;
	registrationEventsRepository: IRegistrationEventsRepository;
	cosmeticService: CosmeticService;
	premiumLedgerService: PremiumLedgerService;
	workerService: IWorkerService<WorkerTaskName>;
}

export interface ReferralGranted {
	tier_id: string;
	reward_type: ReferralTierReward['type'];
}

export type ReferralEvaluation = 'valid' | 'rejected' | 'retry' | 'deferred' | 'moved' | 'skipped';

const CHECK_TTL_AFTER_DUE_SECONDS = REFERRAL_DECISION_WINDOW_DAYS * SECONDS_PER_DAY;
const IP_WINDOW_MS = 30 * MS_PER_DAY;
const IP_EVENTS_READ_LIMIT = 500;
const DAILY_COUNTER_TTL_SECONDS = 2 * SECONDS_PER_DAY;
const CHECK_PAGE = 500;
// TEMPORARY: at most 20 000 evaluations queued a run (a minute, ~330/s); the rest wait for the next run and
// hold the cursor. Trigger: the cursor lags 15 minutes (processReferralChecks warns). Path: a bigger budget with more
// referral lane processes, then 64 check shards.
const MAX_QUEUED_PER_RUN = 20_000;
// The "queued" mark per check row, like the shop's verify flag: a row waiting in the job queue is not
// queued again by every minute's run. The job key dedupes too, but only inside the stream's duplicate window.
const QUEUED_FLAG_SECONDS = 600;
const CURSOR_KEY = 'referral:checks:cursor';
const LOCK_KEY = 'referral:checks:lock';
const LOCK_SECONDS = 60;
// V5: a walk stops after 50 s, before its lock can lapse, so two runs never walk at once.
const WALK_BUDGET_MS = 50_000;
// V5: a row whose evaluation fails this many times moves a day on, so it cannot hold the cursor on its slot.
const MAX_EVALUATION_ATTEMPTS = 5;
const BACKFILL_PAGE = 500;

const queuedFlagKey = (refereeId: bigint, slot: number) => `referral:checks:queued:${refereeId}:${slot}`;
const attemptsKey = (refereeId: bigint, slot: number) => `referral:checks:attempts:${refereeId}:${slot}`;
const dailyKey = (referrerId: bigint, day: number) => `referral:daily:${referrerId}:${day}`;

function checkTtlSeconds(dueAt: Date, now: Date): number {
	return Math.max(0, Math.ceil((dueAt.getTime() - now.getTime()) / 1000)) + CHECK_TTL_AFTER_DUE_SECONDS;
}

// The anonymised row of a deleted account: no counter or list row is written for it again.
function isDeleted(user: User | null): boolean {
	return !user || (user.flags & (UserFlags.DELETED | UserFlags.SELF_DELETED)) !== 0n;
}

export class ReferralRewardService {
	constructor(readonly deps: ReferralRewardServiceDeps) {}

	// Every minute: one evaluateReferral job per row of the CLOSED check slots from the cursor on. The cursor
	// stays on the oldest slot that still has rows, so it moves only past slots their jobs emptied; with no cursor it
	// starts 14 days back (one run of 336 slots × 16 shards, mostly empty). No table scan. One
	// run at a time (null: another run holds the lock).
	// TEMPORARY: the cursor lives in KV only; lost, it restarts 14 days back (rereads, never skips). Trigger: a
	// run reading more than 5 000 empty partitions. Path: keep it in a Cassandra row.
	async reconcileChecks(now: Date): Promise<{queued: number; lagSeconds: number} | null> {
		const {kvClient} = this.deps;
		const token = randomUUID();
		if (!(await kvClient.acquireLock(LOCK_KEY, token, LOCK_SECONDS))) return null;
		try {
			return await this.walkChecks(now);
		} finally {
			await kvClient.releaseLock(LOCK_KEY, token);
		}
	}

	private async walkChecks(now: Date): Promise<{queued: number; lagSeconds: number}> {
		const {kvClient, repository, workerService} = this.deps;
		const currentSlot = referralCheckSlot(now);
		const stored = await kvClient.get(CURSOR_KEY);
		const cursor = stored === null ? Number.NaN : Number(stored);
		// Older rows have reached their TTL, so a lost, stale or garbled cursor never walks back further.
		const oldestLive = referralCheckSlot(new Date(now.getTime() - CHECK_TTL_AFTER_DUE_SECONDS * 1000));
		const firstSlot = Number.isSafeInteger(cursor) ? Math.min(Math.max(cursor, oldestLive), currentSlot) : oldestLive;
		const deadline = Date.now() + WALK_BUDGET_MS;
		let oldestWaiting = currentSlot;
		let queued = 0;
		const full = () => queued >= MAX_QUEUED_PER_RUN || Date.now() >= deadline;
		let slot = firstSlot;
		for (; slot < currentSlot && !full(); slot++) {
			let waiting = false;
			for (let shard = 0; shard < REFERRAL_CHECK_SHARDS && !full(); shard++) {
				let after: UserID | undefined;
				for (;;) {
					const rows = await repository.listChecks(slot, shard, CHECK_PAGE, after);
					for (const row of rows) {
						waiting = true;
						if (queued >= MAX_QUEUED_PER_RUN) break;
						if (!(await kvClient.setnx(queuedFlagKey(row.referee_id, slot), '1', QUEUED_FLAG_SECONDS))) continue;
						await workerService.addJob(
							'evaluateReferral',
							{referee_id: row.referee_id.toString(), slot, shard},
							{jobKey: `${row.referee_id}:${slot}`, skipLedger: true},
						);
						queued++;
					}
					if (full() || rows.length < CHECK_PAGE) break;
					after = rows[rows.length - 1]!.referee_id;
				}
			}
			if (waiting || full()) oldestWaiting = Math.min(oldestWaiting, slot);
		}
		// A walk cut short keeps the cursor on the first slot it did not finish.
		oldestWaiting = Math.min(oldestWaiting, slot);
		await kvClient.set(CURSOR_KEY, String(oldestWaiting));
		const closedAt = (oldestWaiting + 1) * REFERRAL_CHECK_SLOT_MS;
		const lagSeconds = oldestWaiting < currentSlot ? Math.max(0, Math.floor((now.getTime() - closedAt) / 1000)) : 0;
		return {queued, lagSeconds};
	}

	// Decides one pending referral whose check row is due. The LWT pending → valid/rejected decides once, so counters
	// move once however often the job runs; every decision deletes the check row and the registration IP with it.
	// enabled=false does not stop this. A crash between the LWT and the counter add loses one count: it
	// delays a reward, never grants a wrong one.
	async evaluate(refereeId: UserID, at: {slot: number; shard: number}, now: Date): Promise<ReferralEvaluation> {
		const check = await this.deps.repository.getCheck({slot: at.slot, shard: at.shard, referee_id: refereeId});
		if (!check || check.due_at.getTime() > now.getTime()) return 'skipped';
		try {
			return await this.decideCheck(check, now);
		} catch (error) {
			return await this.failedAttempt(check, now, error);
		}
	}

	// the job retries a failed evaluation; after MAX_EVALUATION_ATTEMPTS the row moves a day on instead, so it does
	// not hold the cursor on its slot, and the job stops. Once an evaluation gets through, the window decides it.
	// TEMPORARY: a row that fails every day moves every day (one job a day) and the warn log names it. Trigger: the
	// same referee in the log for days. Path: a dead-letter row the admin view lists.
	private async failedAttempt(check: ReferralCheckRow, now: Date, error: unknown): Promise<ReferralEvaluation> {
		const {kvClient, repository} = this.deps;
		const key = attemptsKey(check.referee_id, check.slot);
		const attempts = await kvClient.incr(key);
		if (attempts === 1) await kvClient.expire(key, SECONDS_PER_DAY);
		if (attempts < MAX_EVALUATION_ATTEMPTS) throw error;
		const dueAt = new Date(now.getTime() + MS_PER_DAY);
		await repository.moveCheck(check, dueAt, checkTtlSeconds(dueAt, now));
		await kvClient.del(key);
		Logger.warn(
			{error, refereeId: check.referee_id.toString(), attempts},
			'Referral evaluation keeps failing; its check row moves a day on',
		);
		return 'moved';
	}

	private async decideCheck(check: ReferralCheckRow, now: Date): Promise<ReferralEvaluation> {
		const {repository, instanceConfigRepository, userRepository} = this.deps;
		const entry = await repository.getUserReferral(check.referee_id);
		if (!entry?.referrer_id || !entry.referred_at || entry.state !== 'pending') {
			await repository.deleteCheck(check);
			return 'skipped';
		}
		const config = await instanceConfigRepository.getReferralConfig();
		const activeFrom = new Date(entry.referred_at.getTime() + config.min_active_days * MS_PER_DAY);
		if (activeFrom.getTime() > now.getTime()) {
			// N was raised after the row was written: it waits for the new day N.
			await repository.moveCheck(check, activeFrom, checkTtlSeconds(activeFrom, now));
			return 'moved';
		}
		const [referee, referrer] = await Promise.all([
			userRepository.findUnique(check.referee_id),
			userRepository.findUnique(entry.referrer_id),
		]);
		const refereeGone = isReferralAccountGone(referee, now);
		const ip =
			referee && !refereeGone ? await this.screenIp(referee, entry.referrer_id, check, entry.referred_at) : null;
		const decision = decideReferral({
			now,
			referredAt: entry.referred_at,
			minActiveDays: config.min_active_days,
			refereeGone,
			refereeBanned: isReferralAccountBanned(referee, now),
			referrerDeleted: isDeleted(referrer),
			referrerAvailable: !isReferralAccountGone(referrer, now) && !isReferralAccountBanned(referrer, now),
			riskBlocked: entry.risk_blocked === true,
			sameIp: ip?.sameIp ?? false,
			ipRegistrations: ip?.registrations ?? 0,
			ipRegistrationLimit: config.ip_registration_limit,
			sameEmail: sameEmailBase(referee?.email ?? null, referrer?.email ?? null),
			pendingApproval: referee?.traits.has(REGISTRATION_PENDING_APPROVAL_TRAIT) ?? false,
			suspicious:
				!!referee &&
				(isMicupAccountLimited(referee) || (referee.flags & UserFlags.DISABLED_SUSPICIOUS_ACTIVITY) !== 0n),
			emailVerified: referee?.emailVerified ?? false,
			lastActiveAt: referee?.lastActiveAt ?? null,
		});
		if (decision.kind === 'retry') {
			await repository.moveCheck(check, decision.at, checkTtlSeconds(decision.at, now));
			return 'retry';
		}
		if (decision.kind === 'rejected') {
			await this.decide(entry, referrer, 'rejected', decision.reason, now);
			await repository.deleteCheck(check);
			return 'rejected';
		}
		const deferDays = await this.dailyCapDeferDays(entry.referrer_id, config.daily_valid_cap, now);
		if (deferDays > 0) {
			// Not a wait: the N+14 day window never rejects a row the cap moved. The IP rules passed, so the
			// registration IP stays behind.
			const dueAt = new Date(now.getTime() + deferDays * MS_PER_DAY);
			await repository.moveCheck(check, dueAt, checkTtlSeconds(dueAt, now), {dropIp: true});
			return 'deferred';
		}
		await this.decide(entry, referrer, 'valid', null, now);
		await repository.deleteCheck(check);
		return 'valid';
	}

	// The IP rules: the registration or last IP among the referrer's authorized IPs, and
	// the registrations in the 30 days up to the referral under the registration IP's same-IP key; later ones do not
	// count. A row without an IP skips them.
	private async screenIp(
		referee: User,
		referrerId: UserID,
		check: ReferralCheckRow,
		referredAt: Date,
	): Promise<{sameIp: boolean; registrations: number}> {
		const {userRepository} = this.deps;
		let sameIp = false;
		for (const ip of new Set([check.reg_ip, referee.lastActiveIp])) {
			if (ip && (await userRepository.checkIpAuthorized(referrerId, ip))) {
				sameIp = true;
				break;
			}
		}
		return {sameIp, registrations: check.reg_ip ? await this.countIpRegistrations(check.reg_ip, referredAt) : 0};
	}

	// TEMPORARY: Fluxer's by-IP and by-subnet reads return the newest 100 rows (so IP_EVENTS_READ_LIMIT never
	// binds): 100+ registrations after the referral under the key, or in a busy IPv6 /48, hide the older ones and the
	// count comes out low (fails open: the referral counts). Trigger: one IP or /48 with 100+ registrations in 44 days. Path: a created_at upper bound on the read.
	private async countIpRegistrations(ip: string, referredAt: Date): Promise<number> {
		const {registrationEventsRepository} = this.deps;
		const since = new Date(referredAt.getTime() - IP_WINDOW_MS);
		const upToReferral = (event: {createdAt: Date}) => event.createdAt.getTime() <= referredAt.getTime();
		const key = referralIpKey(ip);
		const subnet = getSubnet(ip);
		// An IPv6 key is its /64: read the /48 the events are indexed by and keep that /64.
		if (key.includes(':') && subnet) {
			const events = await registrationEventsRepository.listBySubnet(subnet, since, IP_EVENTS_READ_LIMIT);
			return events.filter((event) => upToReferral(event) && referralIpKey(event.ip) === key).length;
		}
		return (await registrationEventsRepository.listByIp(ip, since, IP_EVENTS_READ_LIMIT)).filter(upToReferral).length;
	}

	// The referrer's place among today's valid referrals; past the cap, the days to wait.
	// TEMPORARY: the row takes a place again on the day it comes back, so a large backlog can slip a day more.
	// Trigger: one referrer with 10^5 deferred rows. Path: keep the cap queue position in KV.
	private async dailyCapDeferDays(referrerId: UserID, cap: number, now: Date): Promise<number> {
		const {kvClient} = this.deps;
		const key = dailyKey(referrerId, Math.floor(now.getTime() / MS_PER_DAY));
		const sequence = await kvClient.incr(key);
		if (sequence === 1) await kvClient.expire(key, DAILY_COUNTER_TTL_SECONDS);
		return capDeferDays(sequence, cap);
	}

	private async decide(
		entry: UserReferralRow,
		referrer: User | null,
		state: 'valid' | 'rejected',
		reason: UserReferralRow['reason'],
		now: Date,
	): Promise<void> {
		const {repository, kvCounterService, workerService} = this.deps;
		if (!(await repository.transitionState(entry.user_id, state, reason, now))) return;
		const referrerId = entry.referrer_id!;
		if (isDeleted(referrer)) return;
		const id = referrerId.toString();
		await kvCounterService.add(REFERRAL_PENDING_COUNTER, id, -1);
		await repository.updateReferrerEntry(referrerId, entry.referred_at!, entry.user_id, state, reason);
		if (state === 'rejected') {
			await kvCounterService.add(REFERRAL_REJECTED_COUNTER, id, 1);
			return;
		}
		const valid = await kvCounterService.add(REFERRAL_VALID_COUNTER, id, 1);
		await repository.setBand(referrerId, valid - 1, valid);
		await workerService.addJob('grantReferralRewards', {user_id: id}, {jobKey: `${id}:${valid}`, skipLedger: true});
	}

	// Grants the enabled tiers the valid count reaches and finishes any reward a crash left 'granting'. The
	// reward row is claimed first (LWT) and every delivery is keyed (cosmetic and ledger 'referral:<tier>', the pending
	// row by granted_at), so a retried job delivers once. A referrer who is gone or banned gets nothing. No DM
	// and no e-mail. `onGranted` runs after each finished reward (its audit entry); a failed tier throws after the
	// others are done, so the job retries it. A backfill passes the stored `config` it read.
	async grantDue(
		userId: UserID,
		options: {backfill: boolean; config?: ReferralConfig; onGranted?: (granted: ReferralGranted) => Promise<void>},
	): Promise<Array<ReferralGranted>> {
		const {repository, instanceConfigRepository, kvCounterService, userRepository} = this.deps;
		const now = new Date();
		const user = await userRepository.findUnique(userId);
		if (isReferralAccountGone(user, now) || isReferralAccountBanned(user, now)) return [];
		const [config, count, rewards] = await Promise.all([
			options.config ?? instanceConfigRepository.getReferralConfig(),
			kvCounterService.get(REFERRAL_VALID_COUNTER, userId.toString()),
			repository.getRewards(userId),
		]);
		const work = rewards.filter((row) => row.status === 'granting');
		for (const tier of dueTiers(config.tiers, count, rewards)) {
			const row: ReferralRewardRow = {
				user_id: userId,
				tier_id: BigInt(tier.id),
				reward: JSON.stringify(tier.reward),
				status: 'granting',
				granted_at: now,
				delivered_at: null,
				delivered_by: null,
				note: null,
				code: null,
			};
			if ((await repository.claimReward(row)) === 'claimed') {
				work.push(row);
				continue;
			}
			const stored = (await repository.getRewards(userId)).find((other) => other.tier_id === row.tier_id);
			if (stored?.status === 'granting') work.push(stored);
		}
		const granted: Array<ReferralGranted> = [];
		let failure: unknown = null;
		for (const row of work) {
			try {
				const done = await this.deliver(row, now);
				if (!done) continue;
				granted.push(done);
				await options.onGranted?.(done);
			} catch (error) {
				failure ??= error;
				Logger.warn(
					{error, userId: userId.toString(), tierId: row.tier_id.toString(), backfill: options.backfill},
					'Referral reward delivery failed; the job retries it',
				);
			}
		}
		if (failure) throw failure;
		return granted;
	}

	private async deliver(row: ReferralRewardRow, now: Date): Promise<ReferralGranted | null> {
		const {repository, cosmeticService, premiumLedgerService} = this.deps;
		const reward = JSON.parse(row.reward) as ReferralTierReward;
		const tierId = row.tier_id.toString();
		if (reward.type === 'offsite') {
			// created_at = granted_at: a retry writes the same pending row.
			await repository.insertPendingReward({
				month: referralPendingMonth(row.granted_at),
				created_at: row.granted_at,
				user_id: row.user_id,
				tier_id: row.tier_id,
			});
		} else if (reward.type === 'cosmetic') {
			await cosmeticService.deliverOwned(row.user_id, BigInt(reward.item_id), `referral:${tierId}`, 'referral', {
				wear: false,
			});
		} else {
			await premiumLedgerService.grant({
				userId: row.user_id,
				grantKey: tierId,
				source: 'referral',
				duration: {unit: 'days', quantity: reward.days},
			});
		}
		const patch =
			reward.type === 'offsite'
				? {status: 'pending_admin' as const}
				: {status: 'auto_delivered' as const, delivered_at: now};
		const moved = await repository.setRewardStatus(row.user_id, row.tier_id, 'granting', patch);
		return moved ? {tier_id: tierId, reward_type: reward.type} : null;
	}

	// One page of a tier backfill: referrers from band(threshold) up, 64 shards a band, until 500 rows are
	// read. Those below the threshold are skipped, the rest go through grantDue (no DM or e-mail), each reward with its
	// `onGranted` audit entry. A closed or deleted tier ends it. The cursor is "band:shard:after". The config is
	// the stored one, read once a page: a worker's cached copy can miss a tier or a threshold just saved.
	async backfillTierPage(
		tierId: string,
		cursor: string | null,
		onGranted?: (userId: UserID, granted: ReferralGranted) => Promise<void>,
	): Promise<{granted: number; nextCursor: string | null}> {
		const {repository, instanceConfigRepository, kvCounterService} = this.deps;
		const config = await instanceConfigRepository.readStoredReferralConfig();
		const tier = config.tiers.find((t) => t.id === tierId);
		if (!tier?.enabled) return {granted: 0, nextCursor: null};
		let [band, shard, after] = parseBackfillCursor(cursor) ?? [referralBand(tier.threshold), 0, undefined];
		let read = 0;
		let granted = 0;
		while (band <= REFERRAL_MAX_BAND && read < BACKFILL_PAGE) {
			const limit = BACKFILL_PAGE - read;
			const rows = await repository.listBand(band, shard, limit, after);
			read += rows.length;
			const ids = rows.map((row) => row.user_id.toString());
			const counts = ids.length > 0 ? await kvCounterService.getMany(REFERRAL_VALID_COUNTER, ids) : [];
			for (const [index, row] of rows.entries()) {
				if (counts[index]! < tier.threshold) continue;
				try {
					const audit = onGranted && ((done: ReferralGranted) => onGranted(row.user_id, done));
					granted += (await this.grantDue(row.user_id, {backfill: true, config, onGranted: audit})).length;
				} catch (error) {
					// Left 'granting': the account's next grantDue finishes it.
					Logger.warn({error, userId: row.user_id.toString(), tierId}, 'Referral backfill grant failed');
				}
			}
			if (rows.length === limit) {
				after = rows[rows.length - 1]!.user_id;
				continue;
			}
			after = undefined;
			if (++shard === REFERRAL_BAND_SHARDS) {
				shard = 0;
				band++;
			}
		}
		return {granted, nextCursor: band > REFERRAL_MAX_BAND ? null : `${band}:${shard}:${after ?? ''}`};
	}
}

function parseBackfillCursor(cursor: string | null): [number, number, UserID | undefined] | null {
	const match = cursor ? /^(\d{1,2}):(\d{1,2}):(\d*)$/.exec(cursor) : null;
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), match[3] ? createUserID(BigInt(match[3])) : undefined];
}
