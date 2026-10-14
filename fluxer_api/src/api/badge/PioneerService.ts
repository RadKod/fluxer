// SPDX-License-Identifier: AGPL-3.0-or-later

import {createUserID, type UserID} from '@app/api/BrandedTypes';
import type {BadgeRepository} from '@app/api/badge/BadgeRepository';
import type {PioneerRepository} from '@app/api/badge/PioneerRepository';
import type {PioneerByUserRow, PioneerStatus} from '@app/api/database/types/BadgeTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import {Logger} from '@app/api/Logger';
import {isMicupAccountLimited} from '@app/api/user/AccountLimit';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import type {WorkerTaskName} from '@app/api/worker/WorkerLaneConfig';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import {ConflictError} from '@fluxer/errors/src/domains/core/ConflictError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';

export const PIONEER_MAX_SLOTS = 10_000;
export const PIONEER_NUMBER_TOKEN = '{n}';
export const PIONEER_STATE_KV_KEY = 'pioneer:state';
// The state row is the source of truth; a stale or half-written KV value lives at most this long.
export const PIONEER_STATE_KV_TTL_SECONDS = 60;
export const PIONEER_DRY_RUN_KV_KEY = 'pioneer:dry_run';
const DRY_RUN_LOCK_SECONDS = 3600;
const STATUSES: ReadonlySet<string> = new Set<PioneerStatus>(['off', 'backfilling', 'open', 'closed']);
const SCAN_PAGE_SIZE = 500;
// The longest timed ban is 8760 hours (TempBanUserRequest); a permanent one ends 100 years out (AdminUserBanService).
const LONGEST_TIMED_BAN_MS = 8760 * 60 * 60 * 1000;
const NOT_COUNTED_FLAGS =
	UserFlags.DELETED | UserFlags.SELF_DELETED | UserFlags.DISABLED_SUSPICIOUS_ACTIVITY | UserFlags.SPAMMER;

type EligibilityRow = Pick<
	UserRow,
	| 'email'
	| 'has_verified_phone'
	| 'email_verified'
	| 'bot'
	| 'system'
	| 'flags'
	| 'suspicious_activity_flags'
	| 'temp_banned_until'
	| 'pending_deletion_at'
>;

const BLOCKER_UNVERIFIED = 1;
const BLOCKER_ACCOUNT_TYPE = 2;
const BLOCKER_FLAGS = 4;
const BLOCKER_LEAVING = 8;
const BLOCKER_BANNED = 16;
const BLOCKER_LIMITED = 32;

// Öncü counts verified people. Blocked: an unverified e-mail; bots and the system user; deleted, self-deleted,
// suspicious-activity disabled and spammer accounts; accounts waiting for deletion; permanently banned accounts; accounts
// with an active account limitation. A timed ban and a user's own disable (DISABLED without an end date) do not block.
function pioneerBlockers(row: EligibilityRow, now: number): number {
	const flags = row.flags ?? 0n;
	let blockers = 0;
	if (row.email_verified !== true) blockers |= BLOCKER_UNVERIFIED;
	if (row.bot || row.system) blockers |= BLOCKER_ACCOUNT_TYPE;
	if ((flags & NOT_COUNTED_FLAGS) !== 0n) blockers |= BLOCKER_FLAGS;
	if (row.pending_deletion_at) blockers |= BLOCKER_LEAVING;
	if ((flags & UserFlags.DISABLED) !== 0n && (row.temp_banned_until?.getTime() ?? 0) > now + LONGEST_TIMED_BAN_MS) {
		blockers |= BLOCKER_BANNED;
	}
	if (
		isMicupAccountLimited({
			flags,
			isBot: row.bot ?? false,
			isSystem: row.system ?? false,
			suspiciousActivityFlags: row.suspicious_activity_flags ?? 0,
			email: row.email ?? null,
			emailVerified: row.email_verified ?? false,
			hasVerifiedPhone: row.has_verified_phone ?? false,
		})
	) {
		blockers |= BLOCKER_LIMITED;
	}
	return blockers;
}

export function isPioneerEligible(row: EligibilityRow | null, now = Date.now()): boolean {
	return row !== null && pioneerBlockers(row, now) === 0;
}

// `previous` can be stale (versioned updates are not compare-and-set): two writes that each lift one blocker may both
// still see one left. A lifted blocker is enough to queue; the job decides from the current row. Writes that lift
// nothing (the first session flag, a new limitation on a risky sign-up) queue nothing.
function liftsBlocker(previous: UserRow | null, updated: UserRow, now: number): boolean {
	if (!previous) return false;
	return (pioneerBlockers(previous, now) & ~pioneerBlockers(updated, now)) !== 0;
}

export function fillPioneerNumber(description: string, sequence: number | null | undefined): string {
	// == null: a row read without the column (an older row, a store that drops nulls) holds undefined.
	return sequence == null ? description : description.replaceAll(PIONEER_NUMBER_TOKEN, String(sequence));
}

function conflict(message: string): ConflictError {
	return new ConflictError({code: APIErrorCodes.CONFLICT, message});
}

// Keeps the `limit` smallest ids in ascending order; memory stays bounded by the numbers left, whatever the user count.
function keepSmallest(sorted: Array<bigint>, id: bigint, limit: number): void {
	if (limit === 0 || (sorted.length === limit && id >= sorted[limit - 1]!)) return;
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (sorted[mid]! < id) low = mid + 1;
		else high = mid;
	}
	sorted.splice(low, 0, id);
	if (sorted.length > limit) sorted.pop();
}

interface PioneerServiceDeps {
	repository: PioneerRepository;
	badgeRepository: BadgeRepository;
	userRepository: IUserRepository;
	kvClient: IKVProvider;
	workerService: IWorkerService<WorkerTaskName>;
}

export interface PioneerBackfillParams {
	badgeId: bigint;
	firstUserId: UserID;
	excludedUserIds: ReadonlyArray<UserID>;
	dryRun: boolean;
	adminUserId: UserID;
	auditLogReason: string | null;
}

export class PioneerService {
	// Closed is final: once a process sees it, account writes stop reading KV for Öncü.
	private closed = false;

	constructor(private readonly deps: PioneerServiceDeps) {}

	// KV first; the state row when KV is empty, holds an unknown value or is down.
	async readStatus(): Promise<PioneerStatus> {
		if (this.closed) return 'closed';
		let status = await this.deps.kvClient.get(PIONEER_STATE_KV_KEY).catch(() => null);
		if (status === null || !STATUSES.has(status)) {
			status = (await this.deps.repository.getState())?.status ?? 'off';
			// Not awaited: a slow or down KV must not hold up the account write. TEMPORARY: a failed KV write only sends the
			// next read to the state row again. NX: this read can be older than the word finishBackfill, stop or close
			// wrote meanwhile (they write unconditionally), so a refill never overwrites one.
			void this.deps.kvClient
				.set(PIONEER_STATE_KV_KEY, status, 'EX', PIONEER_STATE_KV_TTL_SECONDS, 'NX')
				.catch(() => null);
		}
		if (status === 'closed') this.closed = true;
		return status as PioneerStatus;
	}

	private async writeKvStatus(status: PioneerStatus): Promise<void> {
		await this.deps.kvClient.setex(PIONEER_STATE_KV_KEY, PIONEER_STATE_KV_TTL_SECONDS, status);
	}

	// UserAccountRepository hook. An account that was already eligible, or a write that lifts no blocker, costs nothing;
	// otherwise one status read and, while open, one job that decides from the current row.
	async onAccountWritten({previous, updated}: {previous: UserRow | null; updated: UserRow}): Promise<void> {
		const now = Date.now();
		if (this.closed || isPioneerEligible(previous, now)) return;
		if (!isPioneerEligible(updated, now) && !liftsBlocker(previous, updated, now)) return;
		if ((await this.readStatus()) !== 'open') return;
		await this.deps.workerService.addJob('assignPioneerBadge', {userId: updated.user_id.toString()});
	}

	async assignFromQueue(userId: UserID): Promise<void> {
		const status = await this.readStatus();
		if (status === 'off' || status === 'backfilling') return;
		// After closing, only a claim cut before its commit goes on (one read for every other late job).
		if (status === 'closed' && (await this.deps.repository.getByUser(userId))?.status !== 'claiming') return;
		await this.assignIfEligible(userId, 'open');
	}

	// Decides from the current row: a queued job, or a backfill item scanned before a ban, a deletion or a new flag.
	async assignIfEligible(userId: UserID, requireStatus: PioneerStatus): Promise<number | null> {
		const user = await this.deps.userRepository.findUnique(userId);
		if (!isPioneerEligible(user?.toRow() ?? null)) return null;
		return this.assign(userId, {requireStatus});
	}

	// Crash-safe order: claim the account (fixes where it probes), claim a slot, write the badge row, commit. A retry or a
	// duplicate job probes from the same start and adopts the slot that already holds this account, so a crash never
	// burns a number and never gives a second one. requireStatus: the live job needs 'open', the backfill 'backfilling',
	// so a stop ends both. A claim cut before its commit still finishes after closing: every number up to the one it
	// holds has its row, so it adopts its own number or ends 'late'. Returns the number the account holds, or null.
	async assign(userId: UserID, options: {requireStatus?: PioneerStatus} = {}): Promise<number | null> {
		const {repository, badgeRepository} = this.deps;
		const state = await repository.getState();
		if (!state?.badge_id) throw new Error('The Öncü badge is not configured');
		let record = await repository.getByUser(userId);
		const finishingClaim = state.status === 'closed' && record?.status === 'claiming';
		if (options.requireStatus && state.status !== options.requireStatus && !finishingClaim) return null;
		if (!record) {
			const claim: PioneerByUserRow = {
				user_id: userId,
				slot: null,
				probe_from: state.next_slot,
				status: 'claiming',
				updated_at: new Date(),
			};
			const claimed = await repository.claimUser(claim);
			record = claimed.applied ? claim : (claimed.existing ?? (await repository.getByUser(userId, true)));
		}
		if (!record) return null;
		if (record.status !== 'claiming') {
			// A ban or a deletion that landed while an earlier attempt was writing the row: make sure the row is gone. A
			// regrant can land between the read and the delete, so read again with SERIAL and put its row back.
			if (record.status === 'revoked' || record.status === 'deleted') {
				await badgeRepository.revokeUserBadge(userId, state.badge_id);
				const current = await repository.getByUser(userId, true);
				if (current?.status === 'granted' && current.slot !== null) {
					await badgeRepository.grantUserBadge({
						user_id: userId,
						badge_id: state.badge_id,
						granted_at: new Date(),
						sequence: current.slot,
					});
				}
				return current?.slot ?? record.slot;
			}
			return record.slot;
		}
		for (let slot = record.probe_from; slot <= PIONEER_MAX_SLOTS; slot++) {
			const taken = await repository.claimSlot(slot, userId);
			if (!taken.applied && (taken.existing ?? (await repository.getSlot(slot)))?.user_id !== userId) continue;
			await badgeRepository.grantUserBadge({
				user_id: userId,
				badge_id: state.badge_id,
				granted_at: new Date(),
				sequence: slot,
			});
			if (!(await repository.setUserStatus(userId, 'claiming', 'granted', slot))) {
				return this.settleLostCommit(userId, slot, state.badge_id);
			}
			// Closed is final: a claim finishing after the close must not pull next_slot back below the last number.
			if (state.status !== 'closed') await repository.setNextSlot(slot + 1);
			if (slot === PIONEER_MAX_SLOTS) await this.close();
			return slot;
		}
		await repository.setUserStatus(userId, 'claiming', 'late');
		await this.close();
		return null;
	}

	// The commit lost to a duplicate job (keep), a ban (drop the row) or an account deletion (drop the row and unlink).
	private async settleLostCommit(userId: UserID, slot: number, badgeId: bigint): Promise<number | null> {
		const record = await this.deps.repository.getByUser(userId, true);
		if (record?.status === 'granted') return record.slot;
		await this.deps.badgeRepository.revokeUserBadge(userId, badgeId);
		if (record?.status === 'deleted') await this.deps.repository.clearSlotUser(slot, userId);
		return null;
	}

	private async close(): Promise<void> {
		const state = await this.deps.repository.getState();
		if (state && state.status !== 'closed') await this.deps.repository.setStatus(state.status, 'closed');
		await this.writeKvStatus('closed');
		this.closed = true;
	}

	// Admin take-back and permanent or CSAM ban: the number stays in the record (a regrant brings it back), the row goes.
	// BadgeAdminController relies on the ConflictError below being thrown only after the badge row is deleted: it records
	// the take-back in the audit log before answering 409.
	async revoke(userId: UserID): Promise<void> {
		const {repository, badgeRepository} = this.deps;
		const state = await repository.getState();
		if (!state?.badge_id) return;
		let settled = false;
		for (let attempt = 0; attempt < 3 && !settled; attempt++) {
			const record = await repository.getByUser(userId, true);
			settled =
				!record ||
				(record.status !== 'granted' && record.status !== 'claiming') ||
				(await repository.setUserStatus(userId, record.status, 'revoked'));
		}
		// The row goes either way (a banned profile must not show it); the throw reaches the ban hook's log or the admin.
		await badgeRepository.revokeUserBadge(userId, state.badge_id);
		if (!settled) throw conflict('The pioneer record kept changing while taking the badge back. Retry.');
	}

	async regrant(userId: UserID, badgeId: bigint): Promise<void> {
		const {repository, badgeRepository} = this.deps;
		const record = await repository.getByUser(userId, true);
		if (!record || record.slot === null || (record.status !== 'revoked' && record.status !== 'granted')) {
			throw conflict('The pioneer badge can only be given back to an account that already holds a pioneer number.');
		}
		if (record.status === 'revoked' && !(await repository.setUserStatus(userId, 'revoked', 'granted'))) {
			throw conflict('The pioneer record changed while giving the badge back. Retry.');
		}
		await badgeRepository.grantUserBadge({
			user_id: userId,
			badge_id: badgeId,
			granted_at: new Date(),
			sequence: record.slot,
		});
	}

	// Account deletion: the number stays burned, nothing links it to the account any more. A throw leaves the deletion
	// hook job to the lane's retries.
	async forget(userId: UserID): Promise<void> {
		const {repository} = this.deps;
		const record = await repository.getByUser(userId, true);
		if (!record || record.status === 'deleted') return;
		const unfinished = record.slot === null && (record.status === 'claiming' || record.status === 'revoked');
		const slot = unfinished ? await this.findClaimedSlot(userId, record.probe_from) : record.slot;
		if (slot !== null) await repository.clearSlotUser(slot, userId);
		if (!(await repository.setUserStatus(userId, record.status, 'deleted', null))) {
			throw new Error('The pioneer record changed during account deletion');
		}
	}

	// A claim that never committed (crash, dead letter, ban mid-claim) may still hold a slot. Every slot from probe_from up
	// to it is held by someone else and a slot row is never removed, so the first missing row ends the search.
	// TEMPORARY: serial reads up to the frontier; only on deleting such an account.
	private async findClaimedSlot(userId: UserID, probeFrom: number): Promise<number | null> {
		for (let slot = probeFrom; slot <= PIONEER_MAX_SLOTS; slot++) {
			const holder = await this.deps.repository.getSlot(slot);
			if (!holder) return null;
			if (holder.user_id === userId) return slot;
		}
		return null;
	}

	async isPioneerBadge(badgeId: bigint): Promise<boolean> {
		return (await this.deps.repository.getState())?.badge_id === badgeId;
	}

	// An account that already has a record (a number or a claim) keeps it: the insert loses and the account is reported
	// apart, never silently counted as excluded. An earlier exclusion (a redelivered or restarted backfill) still counts.
	async exclude(userIds: ReadonlyArray<UserID>): Promise<{excluded: Array<UserID>; alreadyRecorded: Array<UserID>}> {
		const excluded: Array<UserID> = [];
		const alreadyRecorded: Array<UserID> = [];
		for (const userId of userIds) {
			const {applied, existing} = await this.deps.repository.claimUser({
				user_id: userId,
				slot: null,
				probe_from: 0,
				status: 'excluded',
				updated_at: new Date(),
			});
			const kept = applied || (existing ?? (await this.deps.repository.getByUser(userId, true)))?.status === 'excluded';
			(kept ? excluded : alreadyRecorded).push(userId);
		}
		if (alreadyRecorded.length > 0) {
			Logger.warn(
				{userIds: alreadyRecorded.map(String)},
				'Öncü exclusion skipped: the account already has a pioneer record',
			);
		}
		return {excluded, alreadyRecorded};
	}

	// One full users scan: the smallest eligible ids with no record or an unfinished claim (assign adopts its number), no
	// more than the numbers left; and how many verified accounts wait only on an account limitation.
	// TEMPORARY: one sequential scanAllUsersPage over every user while the live hook stays shut; past 1 M users
	// or a 10 min scan, split it over token ranges with scanUsersTokenRangePage in parallel (ProcessInactivityDeletions).
	async collectBackfillIds(): Promise<{ids: Array<UserID>; flagged: number}> {
		const state = await this.deps.repository.getState();
		const room = Math.max(0, PIONEER_MAX_SLOTS - (state?.next_slot ?? 1) + 1);
		const picked: Array<bigint> = [];
		let flagged = 0;
		let pageState: string | null = null;
		do {
			const page = await this.deps.userRepository.scanAllUsersPage(SCAN_PAGE_SIZE, pageState);
			for (const user of page.users) {
				const row = user.toRow();
				if (!isPioneerEligible(row)) {
					if (
						isPioneerEligible({
							...row,
							flags: (row.flags ?? 0n) & ~UserFlags.ACCOUNT_LIMITED,
							suspicious_activity_flags: 0,
						})
					)
						flagged++;
					continue;
				}
				const id = BigInt(user.id);
				if (room === 0 || (picked.length === room && id >= picked[room - 1]!)) continue;
				const record = await this.deps.repository.getByUser(user.id);
				if (record && record.status !== 'claiming') continue;
				keepSmallest(picked, id, room);
			}
			pageState = page.pageState;
		} while (pageState);
		return {ids: picked.map((id) => createUserID(id)), flagged};
	}

	// Opens the live hook, then numbers whoever turned eligible while the first pass ran (the hook was off for them). KV
	// gets the state row's final word whatever the switch did, so a lost race never leaves the hook shut.
	async finishBackfill(): Promise<ReadonlyArray<[string, string]>> {
		const {repository} = this.deps;
		await repository.setStatus('backfilling', 'open');
		const opened = (await repository.getState())?.status ?? 'off';
		// A KV failure must not skip the catch-up; the hook falls back to the state row once the KV entry expires.
		await this.writeKvStatus(opened).catch((error) => Logger.warn({error}, 'Öncü state KV write failed'));
		let late: Array<UserID> = [];
		let failed = 0;
		if (opened === 'open') {
			late = (await this.collectBackfillIds()).ids;
			for (const userId of late) {
				try {
					await this.assignIfEligible(userId, 'open');
				} catch (error) {
					failed++;
					Logger.warn({error, userId: userId.toString()}, 'Öncü catch-up assignment failed');
				}
			}
		}
		const state = await repository.getState();
		return [
			['status', state?.status ?? 'off'],
			['next_slot', String(state?.next_slot ?? 1)],
			['catch_up_count', String(late.length)],
			['catch_up_failed', String(failed)],
		];
	}

	async startBackfill(params: PioneerBackfillParams): Promise<void> {
		const {repository, badgeRepository, userRepository, kvClient, workerService} = this.deps;
		const badge = await badgeRepository.getBadge(params.badgeId);
		if (!badge) throw new NotFoundError({code: APIErrorCodes.NOT_FOUND});
		if (!badge.description.includes(PIONEER_NUMBER_TOKEN)) {
			throw conflict(`The pioneer badge text must contain ${PIONEER_NUMBER_TOKEN}.`);
		}
		const first = await userRepository.findUnique(params.firstUserId);
		if (!first) throw new UnknownUserError();
		if (!isPioneerEligible(first.toRow()) || params.excludedUserIds.includes(params.firstUserId)) {
			throw conflict('The first account cannot get number 1: it is not eligible or is excluded.');
		}
		const current = await repository.getState();
		// The numbers belong to one badge: a rerun after a stop names the same one.
		if (current?.badge_id != null && current.badge_id !== params.badgeId) {
			throw conflict('Pioneer numbering already belongs to another badge.');
		}
		if (params.dryRun) {
			// A dry run writes nothing, the state row included; one at a time, since each one is a full users scan.
			if ((current?.status ?? 'off') !== 'off') throw conflict('The pioneer distribution is not stopped.');
			if ((await kvClient.set(PIONEER_DRY_RUN_KV_KEY, '1', 'EX', DRY_RUN_LOCK_SECONDS, 'NX')) === null) {
				throw conflict('A pioneer dry run is already running.');
			}
		} else {
			const state = current ?? (await repository.ensureState());
			if (state.status !== 'off' || !(await repository.setStatus('off', 'backfilling', params.badgeId))) {
				throw conflict('The pioneer distribution is not stopped.');
			}
		}
		try {
			if (!params.dryRun) await this.writeKvStatus('backfilling');
			await workerService.addJob('backfillPioneerBadges', {
				first_user_id: params.firstUserId.toString(),
				excluded_user_ids: params.excludedUserIds.map(String),
				dry_run: params.dryRun,
				admin_user_id: params.adminUserId.toString(),
				audit_log_reason: params.auditLogReason,
			});
		} catch (error) {
			// No job was queued: switch numbering back off (the hook would stay shut) and free the dry-run lock.
			if (params.dryRun) await kvClient.del(PIONEER_DRY_RUN_KV_KEY);
			else if (await repository.setStatus('backfilling', 'off')) await this.writeKvStatus('off');
			throw error;
		}
	}

	// A backfill job cancelled on the jobs page: it never opens numbering. Only a distribution still in the backfill is
	// shut, so a rerun that already opened stays open.
	async abandonBackfill(): Promise<void> {
		await this.deps.repository.setStatus('backfilling', 'off');
		await this.writeKvStatus((await this.deps.repository.getState())?.status ?? 'off');
	}

	async endDryRun(): Promise<void> {
		await this.deps.kvClient.del(PIONEER_DRY_RUN_KV_KEY);
	}

	// Kill switch: the hook stops at its next status read; queued jobs and a running backfill give nothing more (they check
	// the state row). Numbers already given stay.
	async stop(): Promise<void> {
		const {repository} = this.deps;
		// Never started: nothing to stop and nothing written, so an empty pioneer_state can still be dropped.
		const state = await repository.getState();
		if (!state) return;
		if (state.status !== 'off' && state.status !== 'closed' && !(await repository.setStatus(state.status, 'off'))) {
			throw conflict('The pioneer state changed while stopping. Retry.');
		}
		await this.writeKvStatus((await repository.getState())?.status ?? 'off');
	}
}
