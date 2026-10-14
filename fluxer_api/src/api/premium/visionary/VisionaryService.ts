// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {CosmeticRepository} from '@app/api/cosmetics/CosmeticRepository';
import type {CosmeticService} from '@app/api/cosmetics/CosmeticService';
import type {VisionarySlotRow} from '@app/api/database/types/PaymentTypes';
import type {UserRow} from '@app/api/database/types/UserTypes';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {UserCacheService} from '@app/api/infrastructure/UserCacheService';
import type {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {Logger} from '@app/api/Logger';
import type {User} from '@app/api/models/User';
import {lifetimePremiumPatch, type PremiumLedgerService} from '@app/api/premium/ledger/PremiumLedgerService';
import type {VisionaryRepository} from '@app/api/premium/visionary/VisionaryRepository';
import type {IUserRepository} from '@app/api/user/IUserRepository';
import {BaseUserUpdatePropagator} from '@app/api/user/services/BaseUserUpdatePropagator';
import {propagateIfPartialChanged} from '@app/api/user/services/PartialUserChangePropagation';
import {createPremiumClearPatch} from '@app/api/user/UserHelpers';
import {mapWithConcurrency} from '@app/api/utils/ConcurrencyUtils';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {PremiumFlags, UserFlags, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {CannotShrinkReservedSlotsError} from '@fluxer/errors/src/domains/core/CannotShrinkReservedSlotsError';
import {NotFoundError} from '@fluxer/errors/src/domains/core/NotFoundError';
import {ShopItemUnavailableError} from '@fluxer/errors/src/domains/payment/ShopItemUnavailableError';
import {UnknownUserError} from '@fluxer/errors/src/domains/user/UnknownUserError';
import type {IKVProvider} from '@pkgs/kv_client/src/IKVProvider';

export const VISIONARY_HOLD_MS = 15 * 60_000; // = SHOP_ORDER_REUSE_MS: a reused open order still holds its number
export const VISIONARY_OVER_CAP_KEY = 'shop:visionary:over-cap';
const MAX_ROUNDS = 5;
const SLOT_WRITE_CONCURRENCY = 16;

export interface VisionaryStock {
	total: number;
	sold: number;
	held: number;
	remaining: number;
	overCapGrants: number;
}

// 'revoked': the order's number was taken back by an admin since; it stays retired and is not given again.
export interface VisionaryDelivery {
	slot: number | null;
	outcome: 'granted' | 'already_granted' | 'already_visionary' | 'revoked';
	overCap: boolean;
}

export interface VisionaryServiceDeps {
	repository: VisionaryRepository;
	userRepository: Pick<IUserRepository, 'findUnique' | 'patchUpsert'>;
	userCacheService: UserCacheService;
	gatewayService: IGatewayService;
	kvClient: IKVProvider;
	// The premium write lock: a ledger repair that read the account before a lifetime grant cannot write it back.
	premiumLedgerService: Pick<
		PremiumLedgerService,
		'withUserLock' | 'ensureUserPremiumLocked' | 'writeUserPremiumLocked' | 'queueRepair'
	>;
	cosmeticService: Pick<CosmeticService, 'deliverOwned' | 'adminRevoke'>;
	cosmeticRepository: Pick<CosmeticRepository, 'listGrants' | 'getOwned'>;
	instanceConfigRepository: Pick<InstanceConfigRepository, 'getShopConfig'>;
}

function isLiveHold(slot: VisionarySlotRow, now: Date): boolean {
	return slot.user_id == null && slot.held_until != null && slot.held_until.getTime() > now.getTime();
}

// Rows upstream code opened carry no version and are never handed out: a CAS needs a non-null expected value.
function isFree(slot: VisionarySlotRow, now: Date): boolean {
	return slot.version != null && slot.user_id == null && !isLiveHold(slot, now);
}

// Micup's Visionary sale on Fluxer's own lifetime premium (premium_type 2, premium_lifetime_sequence, visionary_slots).
// Numbers are held and taken only with CAS on the slot row; a retired number keeps its owner id.
export class VisionaryService {
	private readonly propagator: BaseUserUpdatePropagator;

	constructor(private readonly deps: VisionaryServiceDeps) {
		this.propagator = new BaseUserUpdatePropagator({
			userCacheService: deps.userCacheService,
			gatewayService: deps.gatewayService,
		});
	}

	async getStock(now: Date = new Date()): Promise<VisionaryStock> {
		const [slots, overCap] = await Promise.all([
			this.deps.repository.listSlots(),
			this.deps.kvClient.get(VISIONARY_OVER_CAP_KEY),
		]);
		return {
			total: slots.length,
			sold: slots.filter((slot) => slot.user_id != null).length,
			held: slots.filter((slot) => isLiveHold(slot, now)).length,
			remaining: slots.filter((slot) => isFree(slot, now)).length,
			overCapGrants: Number(overCap ?? 0),
		};
	}

	async setTotal(total: number): Promise<{totalBefore: number; stock: VisionaryStock}> {
		const now = new Date();
		const slots = await this.deps.repository.listSlots();
		const top = slots.at(-1)?.slot_index ?? 0;
		const added = Array.from({length: Math.max(0, total - slots.length)}, (_, i) => top + i + 1);
		// A lost insert means an over-cap grant took that index first; the slot exists either way.
		await mapWithConcurrency(added, SLOT_WRITE_CONCURRENCY, (slotIndex) =>
			this.deps.repository.insertSlot({
				slot_index: slotIndex,
				user_id: null,
				version: 1,
				order_id: null,
				held_until: null,
			}),
		);
		const removed = slots.slice(total);
		const busy = removed.filter((slot) => slot.user_id != null || isLiveHold(slot, now));
		if (busy.length > 0) {
			throw new CannotShrinkReservedSlotsError(busy.map((slot) => slot.slot_index));
		}
		const deleted = await mapWithConcurrency(removed, SLOT_WRITE_CONCURRENCY, (slot) =>
			this.deps.repository.deleteSlot(slot),
		);
		const raced = removed.filter((_, i) => !deleted[i]);
		if (raced.length > 0) {
			throw new CannotShrinkReservedSlotsError(raced.map((slot) => slot.slot_index));
		}
		return {totalBefore: slots.length, stock: await this.getStock()};
	}

	async holdForOrder(_userId: UserID, orderId: bigint, now: Date = new Date()): Promise<number> {
		const heldUntil = new Date(now.getTime() + VISIONARY_HOLD_MS);
		for (let round = 0; round < MAX_ROUNDS; round++) {
			const slots = await this.deps.repository.listSlots();
			const own = slots.find((slot) => slot.order_id === orderId && isLiveHold(slot, now));
			if (own) {
				return own.slot_index;
			}
			const free = slots.filter((slot) => isFree(slot, now));
			if (free.length === 0) {
				break;
			}
			for (const slot of free) {
				if (await this.deps.repository.claim(slot, {order_id: orderId, held_until: heldUntil})) {
					return slot.slot_index;
				}
			}
		}
		throw new ShopItemUnavailableError();
	}

	async releaseHold(orderId: bigint): Promise<void> {
		const slots = await this.deps.repository.listSlots();
		const held = slots.find((slot) => slot.user_id == null && slot.order_id === orderId);
		if (held) {
			await this.deps.repository.claim(held, {order_id: null, held_until: null});
		}
	}

	async takeSlot(
		userId: UserID,
		opts: {orderId: bigint | null; slot?: number; allowOverCap: boolean},
	): Promise<{slot: number; overCap: boolean} | null> {
		const {orderId} = opts;
		for (let round = 0; round < MAX_ROUNDS; round++) {
			const now = new Date();
			const slots = await this.deps.repository.listSlots();
			if (orderId !== null) {
				// The order's own number, even when its hold ended and nobody took it meanwhile.
				const own = slots.find(
					(slot) => slot.order_id === orderId && (slot.user_id == null || slot.user_id === userId),
				);
				if (own?.user_id === userId) {
					return {slot: own.slot_index, overCap: false};
				}
				if (own) {
					if (await this.deps.repository.claim(own, {user_id: userId, held_until: null})) {
						return {slot: own.slot_index, overCap: false};
					}
					continue;
				}
			}
			const candidates = slots.filter(
				(slot) => (opts.slot === undefined || slot.slot_index === opts.slot) && isFree(slot, now),
			);
			if (opts.slot !== undefined && candidates.length === 0) {
				return null;
			}
			for (const slot of candidates) {
				if (await this.deps.repository.claim(slot, {user_id: userId, order_id: orderId, held_until: null})) {
					return {slot: slot.slot_index, overCap: false};
				}
			}
			if (candidates.length > 0) {
				continue;
			}
			if (!opts.allowOverCap) {
				return null;
			}
			// Fluxer's own rule: a paid buyer always gets a number, above the admin total if the hold ended meanwhile.
			const top = slots.at(-1)?.slot_index ?? 0;
			for (let next = top + 1; next <= top + MAX_ROUNDS; next++) {
				if (
					await this.deps.repository.insertSlot({
						slot_index: next,
						user_id: userId,
						order_id: orderId,
						version: 1,
						held_until: null,
					})
				) {
					Logger.warn(
						{orderId: orderId?.toString(), slot: next},
						'Visionary number given above the admin total: the payment arrived after its hold ended',
					);
					await this.deps.kvClient.incr(VISIONARY_OVER_CAP_KEY);
					return {slot: next, overCap: true};
				}
			}
		}
		throw new Error('Visionary slot claim lost too many concurrent updates');
	}

	// Checked and given under the account's premium lock, so two orders (or an order and an admin grant) never give one
	// account two numbers and a take-back never races a delivery; a busy lock is ResourceLockedError (the shop retries).
	// A second order finds the account a Visionary before it takes a number: its hold is freed, as it was never any
	// account's number, and the shop logs it for a refund by hand.
	async deliverForOrder(userId: UserID, orderId: bigint): Promise<VisionaryDelivery> {
		const delivery = await this.deps.premiumLedgerService.withUserLock(userId, async (): Promise<VisionaryDelivery> => {
			const user = await this.findLiveUser(userId);
			const slots = await this.deps.repository.listSlots();
			const taken = slots.find((slot) => slot.order_id === orderId && slot.user_id === userId);
			if (taken?.held_until != null) {
				return {slot: taken.slot_index, outcome: 'revoked', overCap: false};
			}
			if (taken) {
				// A delivery that stopped after taking its number. Had the account become a Visionary with another number
				// meanwhile, this one stays with it unused (retired: a number bound to an account is never sold again).
				const outcome = await this.writeLifetime(user, taken.slot_index, true);
				return {slot: outcome === 'already_visionary' ? null : taken.slot_index, outcome, overCap: false};
			}
			if (this.isVisionary(user)) {
				await this.releaseHold(orderId);
				return {slot: null, outcome: 'already_visionary', overCap: false};
			}
			const given = (await this.takeSlot(userId, {orderId, allowOverCap: true}))!;
			await this.writeLifetime(user, given.slot, true);
			return {slot: given.slot, outcome: 'granted', overCap: given.overCap};
		});
		if (delivery.outcome === 'granted' || delivery.outcome === 'already_granted') {
			await this.deliverRewards(userId, delivery.slot!);
		}
		return delivery;
	}

	// The admin way in: the asked-for free number or the lowest free one, never above the total.
	async adminGrant(
		userId: UserID,
		slot?: number,
	): Promise<{slot: number | null; changed: boolean; rewardCount: number}> {
		const given = await this.deps.premiumLedgerService.withUserLock(userId, async () => {
			const user = await this.findLiveUser(userId);
			if (this.isVisionary(user)) {
				return {slot: user.premiumLifetimeSequence, changed: false};
			}
			const taken = await this.takeSlot(userId, {orderId: null, slot, allowOverCap: false});
			if (!taken) {
				throw new ShopItemUnavailableError();
			}
			await this.writeLifetime(user, taken.slot, false);
			return {slot: taken.slot, changed: true};
		});
		// A repeat gives what a grant that failed after its account write left undelivered (one delivery per grant key).
		return {...given, rewardCount: given.slot === null ? 0 : await this.deliverRewards(userId, given.slot)};
	}

	// The slot row keeps its owner, so the number is retired and never sold again. Paid ledger time the account still
	// has is written back under the same lock; a #0000 tag is marked for the session-start reset.
	async adminRevoke(userId: UserID): Promise<{slot: number | null; changed: boolean; rewardsTakenBack: number}> {
		const slot = await this.deps.premiumLedgerService.withUserLock(userId, async () => {
			const user = await this.deps.userRepository.findUnique(userId);
			if (!user) {
				throw new UnknownUserError();
			}
			if (!this.isVisionary(user)) {
				return undefined;
			}
			// Marked before the account is written: a crash between the two leaves a Visionary the admin takes back
			// again, never a retried order delivery that gives the number back.
			if (user.premiumLifetimeSequence != null) {
				await this.markTakenBack(user.premiumLifetimeSequence);
			}
			const patch: Partial<UserRow> = {
				...createPremiumClearPatch(),
				premium_lifetime_sequence: null,
				...(user.discriminator === 0 ? {premium_flags: user.premiumFlags | PremiumFlags.DISCRIMINATOR} : {}),
			};
			const updated = await this.deps.userRepository.patchUpsert(userId, patch, user.toRow());
			// Ledger time comes back first, so the badge is compared with the final account. Announced even when that
			// write-back throws (the worker reads the row when it sends) and before the USER_UPDATE, which may throw: a
			// repeated take-back finds no Visionary and announces nothing.
			let current = updated;
			try {
				current = (await this.deps.premiumLedgerService.ensureUserPremiumLocked(userId)).user ?? updated;
			} finally {
				await this.propagateBadge(user, current, 'after a Visionary take-back');
			}
			await this.propagator.dispatchUserUpdate(current);
			return user.premiumLifetimeSequence;
		});
		if (slot === undefined) {
			// A take-back that failed after its account write left the rewards of the number it retired: taken back again.
			const retired = (await this.deps.repository.listSlots()).filter(
				(row) => row.user_id === userId && row.held_until != null,
			);
			let rewardsTakenBack = 0;
			for (const row of retired) {
				rewardsTakenBack += await this.takeBackRewards(userId, row.slot_index);
			}
			return {slot: null, changed: false, rewardsTakenBack};
		}
		return {slot, changed: true, rewardsTakenBack: await this.takeBackRewards(userId, slot)};
	}

	private async takeBackRewards(userId: UserID, slot: number | null): Promise<number> {
		const prefix = `visionary:${slot}:`;
		const rewards = (await this.deps.cosmeticRepository.listGrants(userId)).filter(
			(grant) => grant.grant_key.startsWith(prefix) && grant.state !== 'revoked',
		);
		let rewardsTakenBack = 0;
		for (const grant of rewards) {
			// Only what the number gave: an item the account owns from elsewhere (its own source) stays, and one it no
			// longer owns is left alone unless its delivery is still running.
			const owned = await this.deps.cosmeticRepository.getOwned(userId, grant.item_id);
			if (owned ? owned.source !== 'visionary' : grant.state !== 'pending') {
				continue;
			}
			if (
				await this.skipGoneItem(slot, grant.item_id, () => this.deps.cosmeticService.adminRevoke(userId, grant.item_id))
			) {
				rewardsTakenBack++;
			}
		}
		return rewardsTakenBack;
	}

	async applyLifetime(userId: UserID, slot: number, purchased: boolean): Promise<boolean> {
		return this.deps.premiumLedgerService.withUserLock(
			userId,
			async () => (await this.writeLifetime(await this.findLiveUser(userId), slot, purchased)) === 'granted',
		);
	}

	// Callers hold the premium lock. A Visionary account is never written: the same number is a repeat, another number
	// means the account already has one (one number per account).
	private async writeLifetime(
		user: User,
		slot: number,
		purchased: boolean,
	): Promise<'granted' | 'already_granted' | 'already_visionary'> {
		if (this.isVisionary(user)) {
			return user.premiumLifetimeSequence === slot ? 'already_granted' : 'already_visionary';
		}
		// An unlocked strip that read the lapsed account before this write can clear premium_type after it; the delayed
		// ledger repair writes the number back. Queued first, like a ledger grant's, so a write that lands is repaired.
		await this.deps.premiumLedgerService.queueRepair(user.id);
		await this.deps.premiumLedgerService.writeUserPremiumLocked(
			user,
			{...lifetimePremiumPatch(user, slot), ...(purchased ? {has_ever_purchased: true} : {})},
			'after a Visionary grant',
		);
		return 'granted';
	}

	// the premium badge lives in the public flags, so its change reaches every guild member list of the account.
	// TEMPORARY: one GUILD_MEMBER_UPDATE per guild of the account.
	private async propagateBadge(oldUser: User | null, newUser: User, context: string): Promise<void> {
		await propagateIfPartialChanged({userCacheService: this.deps.userCacheService}, oldUser, newUser, context);
	}

	// held_until on an owned row is the time an admin took the number back: the row keeps its owner (retired) and the
	// order that bought it never gives it again (deliverForOrder 'revoked').
	private async markTakenBack(slotIndex: number): Promise<void> {
		for (let round = 0; round < MAX_ROUNDS; round++) {
			const slot = (await this.deps.repository.listSlots()).find((row) => row.slot_index === slotIndex);
			if (!slot || slot.version == null || slot.held_until != null) {
				return;
			}
			if (await this.deps.repository.claim(slot, {held_until: new Date()})) {
				return;
			}
		}
		throw new Error('Visionary slot kept changing while it was being taken back');
	}

	// One delivery per number and item (cosmetic_grants), worn like a purchase. A reward added later does not reach
	// earlier Visionaries by itself (TEMPORARY: the admin gives it by hand if ever wanted).
	private async deliverRewards(userId: UserID, slot: number): Promise<number> {
		const {visionary_reward_item_ids: itemIds} = await this.deps.instanceConfigRepository.getShopConfig();
		let delivered = 0;
		for (const id of itemIds) {
			const itemId = BigInt(id);
			const deliver = () =>
				this.deps.cosmeticService.deliverOwned(userId, itemId, `visionary:${slot}:${id}`, 'visionary');
			if ((await this.skipGoneItem(slot, itemId, deliver)) === 'delivered') {
				delivered++;
			}
		}
		return delivered;
	}

	private async skipGoneItem<T>(slot: number | null, itemId: bigint, run: () => Promise<T>): Promise<T | null> {
		try {
			return await run();
		} catch (error) {
			// Only the missing item; a missing account (UnknownUserError is a NotFoundError too) still fails the grant.
			if (!(error instanceof NotFoundError) || error.code !== APIErrorCodes.NOT_FOUND) {
				throw error;
			}
			Logger.warn({slot, itemId: itemId.toString()}, 'Visionary reward item is gone; skipped');
			return null;
		}
	}

	isVisionary(user: User): boolean {
		return user.premiumType === UserPremiumTypes.LIFETIME;
	}

	private async findLiveUser(userId: UserID): Promise<User> {
		const user = await this.deps.userRepository.findUnique(userId);
		if (!user || (user.flags & UserFlags.DELETED) !== 0n) {
			throw new UnknownUserError();
		}
		return user;
	}
}
