// SPDX-License-Identifier: AGPL-3.0-or-later

import type {PremiumLedgerRow} from '@app/api/database/types/PremiumLedgerTypes';
import type {ShopOrderRow} from '@app/api/database/types/ShopTypes';
import type {User} from '@app/api/models/User';
import {checkIsPremium} from '@app/api/user/UserHelpers';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {formatShopAzn, formatShopTry} from '@fluxer/schema/src/domains/shop/ShopPriceFormatting';

// The one price function of the shop. Amounts are whole numbers: US cents, qepik and the rate in
// millionths; every division rounds half up. The largest inputs the admin can set (10 000 000 cents, rate 3.0) stay far
// below Number.MAX_SAFE_INTEGER, so plain numbers are exact.

export const SHOP_MIN_AZN_MINOR = 10;
const INT64_MAX = 9_223_372_036_854_775_807n;
const MAX_ORDER_DESCRIPTION_LENGTH = 200;

export type ShopSkuRef =
	| {kind: 'cosmetic'; itemId: bigint}
	| {kind: 'premium'; months: 1 | 3 | 12}
	| {kind: 'visionary'}
	| {kind: 'bundle'; bundleId: bigint};

export function parseShopSku(sku: string): ShopSkuRef | null {
	if (sku === 'visionary') return {kind: 'visionary'};
	const premium = /^premium:(1|3|12)$/.exec(sku);
	if (premium) return {kind: 'premium', months: Number(premium[1]) as 1 | 3 | 12};
	const idSku = /^(cosmetic|bundle):([1-9]\d{0,18})$/.exec(sku);
	if (!idSku) return null;
	const id = BigInt(idSku[2]);
	if (id > INT64_MAX) return null;
	return idSku[1] === 'cosmetic' ? {kind: 'cosmetic', itemId: id} : {kind: 'bundle', bundleId: id};
}

export function bundleSku(bundleId: bigint): string {
	return `bundle:${bundleId}`;
}

// The one rule for items and bundles alike: item_sales_open, not premium_sales_open, opens the
// sale; the premium member discount applies; a lifetime premium account may buy.
export function sellsAsCosmetic(ref: ShopSkuRef | null): boolean {
	return ref?.kind === 'cosmetic' || ref?.kind === 'bundle';
}

// floor((2n + d) / 2d) for n, d ≥ 0: n / d rounded half up without floating point.
export function roundHalfUpDiv(numerator: number, denominator: number): number {
	return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function isCampaignActive(percent: number | null, endsAt: Date | null, now: Date): boolean {
	return percent != null && percent > 0 && (endsAt === null || endsAt.getTime() > now.getTime());
}

export interface ShopPriceInput {
	baseUsdCents: number;
	campaignPercent: number | null;
	campaignEndsAt: Date | null;
	premiumPercent: number;
	applyPremium: boolean;
	rateMicro: number;
	now: Date;
}

export interface ShopPriceBreakdown {
	baseUsdCents: number;
	campaignPercent: number;
	campaignUsdCents: number;
	premiumPercent: number;
	finalUsdCents: number;
	rateMicro: number;
	amountAznMinor: number;
}

export function computeShopPrice(input: ShopPriceInput): ShopPriceBreakdown {
	const campaignPercent = isCampaignActive(input.campaignPercent, input.campaignEndsAt, input.now)
		? input.campaignPercent!
		: 0;
	const premiumPercent = input.applyPremium ? input.premiumPercent : 0;
	const campaignUsdCents = roundHalfUpDiv(input.baseUsdCents * (100 - campaignPercent), 100);
	const finalUsdCents = roundHalfUpDiv(campaignUsdCents * (100 - premiumPercent), 100);
	return {
		baseUsdCents: input.baseUsdCents,
		campaignPercent,
		campaignUsdCents,
		premiumPercent,
		finalUsdCents,
		rateMicro: input.rateMicro,
		amountAznMinor: roundHalfUpDiv(finalUsdCents * input.rateMicro, 1_000_000),
	};
}

export function isSellable(price: ShopPriceBreakdown): boolean {
	return price.finalUsdCents >= 1 && price.amountAznMinor >= SHOP_MIN_AZN_MINOR;
}

export function formatRateMicro(rateMicro: number): string {
	const tenThousandths = roundHalfUpDiv(rateMicro, 100);
	return `${Math.floor(tenThousandths / 10_000)}.${String(tenThousandths % 10_000).padStart(4, '0')}`;
}

// Premium member discount only for accounts that bought premium: a trial is given only to an
// account without premium, so a non-trial grant applied after the trial is a purchase, a code or an admin grant, and
// applied_grants keeps the newest 200 keys, so that grant is there. Lifetime premium never writes a ledger key.
export function isPaidPremiumForShop(
	user: User,
	ledger: Pick<PremiumLedgerRow, 'trial_used_at' | 'applied_grants'> | null,
): boolean {
	if (!checkIsPremium(user)) return false;
	if (user.premiumType === UserPremiumTypes.LIFETIME) return true;
	if (!ledger?.trial_used_at) return true;
	const trialUsedAt = ledger.trial_used_at;
	for (const [key, appliedAt] of ledger.applied_grants ?? []) {
		if (!key.startsWith('trial:') && appliedAt.getTime() > trialUsedAt.getTime()) return true;
	}
	return false;
}

// The Payriff description uses the store quote frozen on the order, never the current settings.
export function describeShopOrder(
	orderId: bigint,
	prepared: {kind: 'cosmetic' | 'premium' | 'visionary' | 'bundle'; itemName: string | null; months: number | null},
	quote: Pick<ShopOrderRow, 'display_currency' | 'display_amount_minor' | 'amount_minor'>,
): string {
	const amountAzn = `${formatShopAzn(quote.amount_minor, 'tr')} AZN`;
	const storePrice =
		quote.display_currency === 'TRY'
			? `${formatShopTry(Number(quote.display_amount_minor), 'tr')}. Bu ödeme Azerbaycan manatı ile alınır: ${amountAzn}`
			: `${formatShopAzn(Number(quote.display_amount_minor), 'tr')} AZN`;
	const suffix = ` — mağazadaki fiyat ${storePrice}. Sipariş #${orderId}`;
	const name =
		prepared.kind === 'visionary'
			? 'sanalyer Visionary'
			: prepared.kind === 'premium'
				? `sanalyer Plus · ${prepared.months} ay`
				: (prepared.itemName ?? '');
	const room = MAX_ORDER_DESCRIPTION_LENGTH - suffix.length;
	const fitted = name.length <= room ? name : `${name.slice(0, room - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
	return `${fitted}${suffix}`;
}
