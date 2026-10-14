// SPDX-License-Identifier: AGPL-3.0-or-later

import {randomUUID} from 'node:crypto';
import type {UserID} from '@app/api/BrandedTypes';
import type {GiftCodeDurationType} from '@app/api/database/types/PaymentTypes';
import type {PremiumLedgerRow} from '@app/api/database/types/PremiumLedgerTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import {Logger} from '@app/api/Logger';
import {addGiftCodeDuration} from '@app/api/models/GiftCode';
import type {User} from '@app/api/models/User';
import type {PremiumLedgerRepository} from '@app/api/premium/ledger/PremiumLedgerRepository';
import type {VisionaryRepository} from '@app/api/premium/visionary/VisionaryRepository';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {propagateIfPartialChanged} from '@app/api/user/services/PartialUserChangePropagation';
import {
	checkHasActivePaidPremium,
	getEffectivePremiumUntil,
	shouldStripExpiredPremium,
} from '@app/api/user/UserHelpers';
import {dispatchUserUpdate} from '@app/api/user/UserMappers';
import {PremiumFlags, UserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {ResourceLockedError} from '@fluxer/errors/src/domains/core/ResourceLockedError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';
import type {IWorkerService} from '@pkgs/worker/src/contracts/IWorkerService';
import {ms, seconds} from 'itty-time';

export type PremiumGrantSource = 'payriff' | 'trial' | 'admin' | 'gift' | 'referral';

export interface PremiumGrant {
	userId: UserID;
	grantKey: string;
	duration: {unit: GiftCodeDurationType; quantity: number};
	source: PremiumGrantSource;
}

export interface PremiumLedgerState {
	user: User | null;
	paidUntil: Date | null;
}

interface PremiumLedgerServiceDeps {
	repository: PremiumLedgerRepository;
	userRepository: Pick<UserRepository, 'findUnique' | 'patchUpsert'>;
	kvClient: IKVProvider;
	workerService: IWorkerService;
	gatewayService: IGatewayService;
	userCacheService: UserCacheService;
	visionaryRepository: Pick<VisionaryRepository, 'findSlot'>;
}

export const TRIAL_GRANT_KEY = 'trial';
// TEMPORARY: 16 shards per day; tombstones of processed rows count against the read tombstone limit, so move to 64
// shards (new rows only, readers scan both layouts) once a (day, shard) partition passes 50K rows.
export const PREMIUM_EXPIRATION_SHARDS = 16;
const MAX_GRANT_ATTEMPTS = 5;
// The key rows (premium_grant_keys) are the lasting record; applied_grants stays as the fast path.
const MAX_APPLIED_GRANTS = 200;
const REPAIR_DELAY_MS = ms('2 minutes');
const EXPIRATION_TTL_FLOOR_SECONDS = seconds('400 days');
const EXPIRATION_TTL_AFTER_DAY_SECONDS = seconds('6 days');
const LOCK_TTL_SECONDS = 30;
const DAY_MS = ms('1 day');

export function premiumExpirationDay(at: Date): number {
	return Math.floor(at.getTime() / DAY_MS);
}

export function premiumExpirationShard(userId: UserID): number {
	return Number(userId % BigInt(PREMIUM_EXPIRATION_SHARDS));
}

function premiumGrantLockKey(userId: UserID): string {
	return `premium:grant:${userId}`;
}

function withAppliedGrant(grants: Map<string, Date> | null, key: string, at: Date): Map<string, Date> {
	const entries = [...(grants ?? []), [key, at] as const].sort(([, a], [, b]) => a.getTime() - b.getTime());
	return new Map(entries.slice(-MAX_APPLIED_GRANTS));
}

function hasPurchasedGrant(row: PremiumLedgerRow): boolean {
	return [...(row.applied_grants?.keys() ?? [])].some((key) => key.startsWith('payriff:'));
}

// Micup Visionary: lifetime premium on a number; it has no end, so every end field is cleared.
export function lifetimePremiumPatch(user: User, slot: number): Partial<UserRow> {
	return {
		premium_type: UserPremiumTypes.LIFETIME,
		premium_lifetime_sequence: slot,
		premium_until: null,
		premium_gift_extension_ends_at: null,
		premium_grace_ends_at: null,
		premium_will_cancel: false,
		premium_billing_cycle: null,
		premium_since: user.premiumSince ?? new Date(),
	};
}

export class PremiumLedgerService {
	constructor(private readonly deps: PremiumLedgerServiceDeps) {}

	async grant(p: PremiumGrant): Promise<{paidUntil: Date; newlyApplied: boolean}> {
		if (!Number.isSafeInteger(p.duration.quantity) || p.duration.quantity <= 0) {
			throw new Error('Premium grant duration must be a positive integer');
		}
		const isTrial = p.source === 'trial';
		const ledgerKey = `${p.source}:${p.grantKey}`;
		if (!isTrial) {
			const keyRow = await this.deps.repository.findGrantKey(p.userId, ledgerKey);
			if (keyRow?.state === 'delivered') {
				const row = await this.deps.repository.find(p.userId);
				if (row?.paid_until) {
					await this.scheduleRepair(p.userId, row.paid_until);
					await this.applyToUser(p.userId);
				}
				return {paidUntil: row?.paid_until ?? new Date(0), newlyApplied: false};
			}
			if (!keyRow) {
				await this.deps.repository.claimGrantKey({
					user_id: p.userId,
					grant_key: ledgerKey,
					state: 'pending',
					created_at: new Date(),
					delivered_at: null,
				});
			}
		}
		for (let attempt = 0; attempt < MAX_GRANT_ATTEMPTS; attempt++) {
			const row = await this.deps.repository.find(p.userId);
			const alreadyApplied = isTrial ? row?.trial_used_at != null : (row?.applied_grants?.has(ledgerKey) ?? false);
			if (row?.paid_until && alreadyApplied) {
				if (!isTrial) {
					await this.deps.repository.markGrantKeyDelivered(p.userId, ledgerKey, new Date());
				}
				await this.scheduleRepair(p.userId, row.paid_until);
				await this.applyToUser(p.userId);
				return {paidUntil: row.paid_until, newlyApplied: false};
			}
			const user = await this.deps.userRepository.findUnique(p.userId);
			// A deleted account keeps its anonymised row; a late grant must not write paid time back into it.
			if (!user || (user.flags & UserFlags.DELETED) !== 0n) {
				throw new UnknownUserError();
			}
			const now = new Date();
			const baseMs = Math.max(
				row?.paid_until?.getTime() ?? 0,
				getEffectivePremiumUntil(user)?.getTime() ?? 0,
				now.getTime(),
			);
			const paidUntil = addGiftCodeDuration(new Date(baseMs), p.duration.unit, p.duration.quantity)!;
			const update = {
				paid_until: paidUntil,
				applied_grants: isTrial
					? (row?.applied_grants ?? null)
					: withAppliedGrant(row?.applied_grants ?? null, ledgerKey, now),
				trial_used_at: isTrial ? now : (row?.trial_used_at ?? null),
			};
			// Indexed and queued before the ledger write, so a grant whose write lands is repaired and expires even when
			// this request dies right after it, and a retry that the ledger refuses (a used trial) leaves nothing undone.
			await this.scheduleRepair(p.userId, paidUntil);
			const applied = row
				? await this.deps.repository.update(p.userId, update, row.version)
				: await this.deps.repository.create({user_id: p.userId, ...update, version: 1});
			if (applied) {
				if (!isTrial) {
					await this.deps.repository.markGrantKeyDelivered(p.userId, ledgerKey, new Date());
				}
				await this.applyToUser(p.userId);
				return {paidUntil, newlyApplied: true};
			}
		}
		throw new Error('Premium ledger grant lost too many concurrent updates');
	}

	// Ends every kind of premium time the account holds at `at` (an admin refund): gift code and trial time are in the
	// same ledger end. The ledger is cut first, so no repair writes the old end back; the user's end fields are checked
	// on every call, so a retry after a crash between the two finishes the cut. A lifetime (Visionary) account has no end
	// fields to cut and keeps its premium. premium_until (Stripe) is left alone.
	async endPaidPremium(
		userId: UserID,
		at: Date = new Date(),
	): Promise<{previousPaidUntil: Date | null; paidUntil: Date | null}> {
		return this.withUserLock(userId, async () => {
			const user = await this.deps.userRepository.findUnique(userId);
			if (!user) {
				throw new UnknownUserError();
			}
			const previousPaidUntil = await this.cutLedgerEnd(userId, at);
			const ledgerCut = previousPaidUntil !== null && previousPaidUntil.getTime() > at.getTime();
			const userCut = [user.premiumGiftExtensionEndsAt, user.premiumGraceEndsAt].some(
				(end) => end != null && end.getTime() > at.getTime(),
			);
			if (userCut) {
				const updatedUser = await this.deps.userRepository.patchUpsert(
					userId,
					{premium_gift_extension_ends_at: at, premium_grace_ends_at: at},
					user.toRow(),
				);
				await dispatchUserUpdate(this.deps.gatewayService, updatedUser);
			}
			if (ledgerCut || userCut) {
				await this.trackExpiration(userId, at);
			}
			return {previousPaidUntil, paidUntil: ledgerCut ? at : previousPaidUntil};
		});
	}

	async isActive(userId: UserID): Promise<boolean> {
		const paidUntil = await this.deps.repository.findPaidUntil(userId);
		return paidUntil !== null && paidUntil.getTime() > Date.now();
	}

	async ensureUserPremium(userId: UserID): Promise<PremiumLedgerState> {
		return this.withUserLock(userId, () => this.ensureUserPremiumLocked(userId));
	}

	async ensureUserPremiumLocked(userId: UserID): Promise<PremiumLedgerState> {
		const [user, row] = await Promise.all([
			this.deps.userRepository.findUnique(userId),
			this.deps.repository.find(userId),
		]);
		const paidUntil = row?.paid_until ?? null;
		// A lifetime (Visionary) account has no end; writing ledger end fields into it would expire it.
		if (user?.premiumType === UserPremiumTypes.LIFETIME) {
			return {user, paidUntil};
		}
		// Micup: an unlocked strip that read the lapsed account before a Visionary grant clears premium_type after it and
		// keeps the number; the grant queues this repair, which writes the number back while its slot is still this one's.
		if (
			user?.premiumLifetimeSequence != null &&
			(await this.holdsVisionaryNumber(user.id, user.premiumLifetimeSequence))
		) {
			const updatedUser = await this.writeUserPremiumLocked(
				user,
				lifetimePremiumPatch(user, user.premiumLifetimeSequence),
				'after a Visionary repair',
			);
			return {user: updatedUser, paidUntil};
		}
		if (!user || !row || !paidUntil || paidUntil.getTime() <= Date.now()) {
			return {user, paidUntil};
		}
		const giftEnd = user.premiumGiftExtensionEndsAt;
		if (checkHasActivePaidPremium(user) && giftEnd && giftEnd.getTime() >= paidUntil.getTime()) {
			return {user, paidUntil};
		}
		// Every premium field is written, including those the read shows set: an unlocked strip (profile view, session
		// start) landing between this read and this write clears them all, and this write must then put them all back.
		const patch: Partial<UserRow> = {
			premium_type: (user.premiumType ?? 0) > 0 ? user.premiumType : UserPremiumTypes.SUBSCRIPTION,
			premium_since: user.premiumSince ?? new Date(),
			premium_gift_extension_ends_at: paidUntil,
			premium_grace_ends_at: paidUntil,
		};
		if (!user.hasEverPurchased && hasPurchasedGrant(row)) {
			patch.has_ever_purchased = true;
		}
		const updatedUser = await this.writeUserPremiumLocked(user, patch, 'after a premium ledger write');
		return {user: updatedUser, paidUntil};
	}

	// Micup: the premium write of a ledger repair and a Visionary grant, under the premium lock the caller holds.
	async writeUserPremiumLocked(user: User, patch: Partial<UserRow>, context: string): Promise<User> {
		if ((user.premiumFlags & PremiumFlags.PERKS_SANITIZED) !== 0) {
			// Queued before the flag is cleared so a failed write leaves the flag set for the next repair to retry.
			await this.deps.workerService.addJob('resetPremiumPerkSanitization', {userId: user.id.toString()});
		} else if (shouldStripExpiredPremium(user)) {
			// A read that shows lapsed premium may have been stripped, its guild perks hidden and the flag set, before this
			// write, which puts the flags of this read back: the reset runs anyway (it only clears hidden members). Its
			// queue failing never drops the premium write.
			try {
				await this.deps.workerService.addJob('resetPremiumPerkSanitization', {userId: user.id.toString()});
			} catch (error) {
				Logger.warn(
					{userId: user.id.toString(), error},
					'Failed to queue the premium perk reset after a premium write',
				);
			}
		}
		const updatedUser = await this.deps.userRepository.patchUpsert(
			user.id,
			{...patch, premium_flags: user.premiumFlags & ~PremiumFlags.PERKS_SANITIZED},
			user.toRow(),
		);
		// Micup: premium starting turns on the premium badge in the public flags; a renewal leaves them alone. Announced
		// before the USER_UPDATE, which may throw, because nothing announces it later. A read that shows lapsed premium
		// may have been stripped, and the strip announced, before this write, so it is announced even when alike.
		await propagateIfPartialChanged(
			{userCacheService: this.deps.userCacheService},
			shouldStripExpiredPremium(user) ? null : user,
			updatedUser,
			context,
		);
		await dispatchUserUpdate(this.deps.gatewayService, updatedUser);
		return updatedUser;
	}

	// A write an unlocked strip can overtake is written again by this delayed ensureUserPremium.
	async queueRepair(userId: UserID): Promise<void> {
		await this.deps.workerService.addJob(
			'ensureUserPremium',
			{userId: userId.toString()},
			{runAt: new Date(Date.now() + REPAIR_DELAY_MS)},
		);
	}

	async trackExpiration(userId: UserID, at: Date): Promise<void> {
		const day = premiumExpirationDay(at);
		const secondsUntilDayEnds = Math.ceil(((day + 1) * DAY_MS - Date.now()) / 1000);
		await this.deps.repository.addExpiration(
			{day, shard: premiumExpirationShard(userId), user_id: userId},
			Math.max(EXPIRATION_TTL_FLOOR_SECONDS, secondsUntilDayEnds + EXPIRATION_TTL_AFTER_DAY_SECONDS),
		);
	}

	async withUserLock<T>(userId: UserID, fn: (keepAlive: () => Promise<void>) => Promise<T>): Promise<T> {
		const key = premiumGrantLockKey(userId);
		const token = randomUUID();
		if (!(await this.deps.kvClient.acquireLock(key, token, LOCK_TTL_SECONDS))) {
			throw new ResourceLockedError();
		}
		try {
			return await fn(async () => {
				if (!(await this.deps.kvClient.extendLock(key, token, LOCK_TTL_SECONDS))) {
					throw new Error('Lost the premium grant lock');
				}
			});
		} finally {
			await this.deps.kvClient.releaseLock(key, token);
		}
	}

	// Returns the ledger end before the cut; applied_grants and trial_used_at stay, so no key is applied twice.
	private async cutLedgerEnd(userId: UserID, at: Date): Promise<Date | null> {
		for (let attempt = 0; attempt < MAX_GRANT_ATTEMPTS; attempt++) {
			const row = await this.deps.repository.find(userId);
			if (!row?.paid_until || row.paid_until.getTime() <= at.getTime()) {
				return row?.paid_until ?? null;
			}
			const update = {paid_until: at, applied_grants: row.applied_grants, trial_used_at: row.trial_used_at};
			if (await this.deps.repository.update(userId, update, row.version)) {
				return row.paid_until;
			}
		}
		throw new Error('Premium ledger kept changing while its paid premium was being ended');
	}

	private async scheduleRepair(userId: UserID, paidUntil: Date): Promise<void> {
		if (paidUntil.getTime() <= Date.now()) {
			return;
		}
		await this.trackExpiration(userId, paidUntil);
		await this.queueRepair(userId);
	}

	// Held while the slot row gives the number to this account and no admin took it back (held_until on an owned row).
	private async holdsVisionaryNumber(userId: UserID, slotIndex: number): Promise<boolean> {
		const slot = await this.deps.visionaryRepository.findSlot(slotIndex);
		return slot?.user_id === userId && slot.held_until == null;
	}

	// The ledger already holds the time and the scheduled repair writes it to the user, so a held lock or a failed
	// announcement delays the user write without failing the grant.
	private async applyToUser(userId: UserID): Promise<void> {
		try {
			await this.ensureUserPremium(userId);
		} catch (error) {
			Logger.warn({userId: userId.toString(), error}, 'Left a premium grant user write to its scheduled repair');
		}
	}
}
