// SPDX-License-Identifier: AGPL-3.0-or-later

import type {UserID} from '@app/api/BrandedTypes';
import type {BadgeRepository} from '@app/api/badge/BadgeRepository';
import type {InstanceConfigRepository, ShopConfig} from '@app/api/instance/InstanceConfigRepository';
import type {User} from '@app/api/models/User';
import type {VisionaryService} from '@app/api/premium/visionary/VisionaryService';
import type {ScannedShopOrder, ShopOrderRepository} from '@app/api/shop/ShopOrderRepository';
import {parseShopSku} from '@app/api/shop/ShopPricing';
import type {UserRepository} from '@app/api/user/repositories/UserRepository';
import {PremiumFlags, UserFlags} from '@fluxer/constants/src/UserConstants';

const SCAN_PAGE_SIZE = 500;

interface EarlyPlusBadgeServiceDeps {
	badgeRepository: Pick<BadgeRepository, 'grantUserBadge' | 'revokeUserBadge'>;
	instanceConfigRepository: Pick<InstanceConfigRepository, 'readStoredShopConfig'>;
	orderRepository: Pick<ShopOrderRepository, 'scanPage'>;
	userRepository: Pick<UserRepository, 'findUnique' | 'patchUpsert'>;
	visionaryService: Pick<VisionaryService, 'isVisionary'>;
}

export interface EarlyPlusBackfillControl {
	shouldStop(): Promise<boolean>;
	onPage(scanned: number, granted: number): Promise<void>;
}

function openBadgeId(config: ShopConfig): bigint | null {
	return config.early_plus_open && config.early_plus_badge_id ? BigInt(config.early_plus_badge_id) : null;
}

// Paid with money: gift codes, admin grants, referral rewards and trials never make a shop order.
function deliveredPlusKind(order: ScannedShopOrder): 'premium' | 'visionary' | null {
	const kind = parseShopSku(order.sku)?.kind;
	return order.status === 'granted' && (kind === 'premium' || kind === 'visionary') ? kind : null;
}

function isDeleted(user: User): boolean {
	return (user.flags & UserFlags.DELETED) !== 0n;
}

// Micup Early Plus: one catalog badge for every account that paid for premium or Visionary while the period is open.
// The badge is a plain user_badges row: a repeat grant is the same upsert, and account deletion drops it with the rest.
// A refund marks the account (premium_flags EARLY_PLUS_REFUNDED), so the backfill, which only sees delivered orders,
// leaves it out until a new paid order clears the mark. The settings are read from the table, not the refreshed
// snapshot, so a close stops grants at once.
export class EarlyPlusBadgeService {
	constructor(private readonly deps: EarlyPlusBadgeServiceDeps) {}

	// Shop delivery of a paid premium or Visionary order. A throw leaves the order paid, so its delivery runs again.
	async grantIfOpen(userId: UserID): Promise<void> {
		await this.setRefundMark(userId, false);
		const badgeId = openBadgeId(await this.deps.instanceConfigRepository.readStoredShopConfig());
		if (badgeId !== null) await this.grant(userId, badgeId);
	}

	// A refund (paid premium ended, Visionary taken back): the badge goes whether the period is open or closed. The mark
	// comes first: a backfill that writes the row after this take-back reads the mark and takes the row back itself.
	async revoke(userId: UserID): Promise<void> {
		await this.setRefundMark(userId, true);
		const {early_plus_badge_id: badgeId} = await this.deps.instanceConfigRepository.readStoredShopConfig();
		if (badgeId) await this.deps.badgeRepository.revokeUserBadge(userId, BigInt(badgeId));
	}

	// Every account with a delivered premium order, or a delivered Visionary order while it still is a Visionary, gets the
	// badge; refunded and deleted accounts do not. A close or a stop ends it at the next page.
	// TEMPORARY: one sequential scan of every shop order, run when the period opens; the job result shows scanned and
	// duration_ms. Trigger: 1 M orders or a scan over 10 minutes. Path: split it over token ranges and scan them in
	// parallel (ProcessInactivityDeletions).
	async backfill(control: EarlyPlusBackfillControl): Promise<{granted: number; scanned: number; stopped: boolean}> {
		let granted = 0;
		let scanned = 0;
		let pageState: string | null = null;
		do {
			if (await control.shouldStop()) return {granted, scanned, stopped: true};
			const badgeId = openBadgeId(await this.deps.instanceConfigRepository.readStoredShopConfig());
			if (badgeId === null) break;
			const page = await this.deps.orderRepository.scanPage(SCAN_PAGE_SIZE, pageState);
			scanned += page.rows.length;
			// true: the account has a delivered premium order; false: only Visionary ones.
			const buyers = new Map<UserID, boolean>();
			for (const order of page.rows) {
				const kind = deliveredPlusKind(order);
				if (kind) buyers.set(order.user_id, buyers.get(order.user_id) === true || kind === 'premium');
			}
			for (const [userId, paidPremium] of buyers) {
				if (!(await this.counts(userId, paidPremium))) continue;
				await this.grant(userId, badgeId);
				// A refund that landed between the read above and this write set its mark before its take-back.
				if (!(await this.counts(userId, paidPremium))) {
					await this.deps.badgeRepository.revokeUserBadge(userId, badgeId);
					continue;
				}
				granted++;
			}
			pageState = page.pageState;
			await control.onPage(scanned, granted);
		} while (pageState);
		return {granted, scanned, stopped: false};
	}

	private async counts(userId: UserID, paidPremium: boolean): Promise<boolean> {
		const user = await this.deps.userRepository.findUnique(userId);
		// Orders outlive their account: a deleted account gets no badge row back.
		if (!user || isDeleted(user) || (user.premiumFlags & PremiumFlags.EARLY_PLUS_REFUNDED) !== 0) return false;
		return paidPremium || this.deps.visionaryService.isVisionary(user);
	}

	private async setRefundMark(userId: UserID, marked: boolean): Promise<void> {
		const user = await this.deps.userRepository.findUnique(userId);
		if (!user || isDeleted(user)) return;
		const flags = marked
			? user.premiumFlags | PremiumFlags.EARLY_PLUS_REFUNDED
			: user.premiumFlags & ~PremiumFlags.EARLY_PLUS_REFUNDED;
		if (flags !== user.premiumFlags) {
			await this.deps.userRepository.patchUpsert(userId, {premium_flags: flags}, user.toRow());
		}
	}

	private async grant(userId: UserID, badgeId: bigint): Promise<void> {
		await this.deps.badgeRepository.grantUserBadge({user_id: userId, badge_id: badgeId, granted_at: new Date()});
	}
}
