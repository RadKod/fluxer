// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {getCachedNumberFormat} from '@app/features/i18n/utils/IntlCache';
import {PremiumHalo} from '@app/features/premium/components/PremiumHalo';
import styles from '@app/features/premium/components/PremiumPlanCard.module.css';
import {planArt, planSavingsPercent} from '@app/features/premium/utils/PremiumPlanSavings';
import {ShopCheckoutModal} from '@app/features/shop/components/modals/ShopCheckoutModal';
import {ShopCountdown} from '@app/features/shop/components/ShopCountdown';
import {ShopPrice} from '@app/features/shop/components/ShopPrice';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import type {ShopPackageEntry} from '@app/features/shop/utils/ShopEntries';
import {
	ADD_TIME_DESCRIPTOR,
	DISCOUNT_PERCENT_DESCRIPTOR,
	PACKAGE_MONTHS_DESCRIPTOR,
	SAVE_VS_MONTHLY_DESCRIPTOR,
	WAS_PRICE_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {campaignShown, formatDiscount, shownCents} from '@app/features/shop/utils/ShopPriceFormat';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import monthArtUrl from '@app/media/images/premium/plus/plan-aylik.webp';
import yearArtUrl from '@app/media/images/premium/plus/plan-yillik.webp';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

const PURCHASE_DESCRIPTOR = msg({
	message: 'Purchase',
	comment: 'Button on a Plus package card for an account without Plus. Opens the checkout.',
});
const RECOMMENDED_DESCRIPTOR = msg({
	message: 'Recommended',
	comment: 'Ribbon on the recommended Plus package card.',
});
const ALL_PERKS_DESCRIPTOR = msg({
	message: 'All {premiumProductName} perks',
	comment: 'Line on every Plus package card: the package gives every Plus perk.',
});
const PLAN_ART = {month: monthArtUrl, year: yearArtUrl} as const;
const DOES_NOT_RENEW_DESCRIPTOR = msg({
	message: 'Does not renew',
	comment: 'Line on every Plus package card: it is a one-time payment, nothing is charged again.',
});

function openCheckout(months: 1 | 3 | 12): void {
	ModalCommands.push(
		modal(() => (
			<ShopCheckoutModal target={{kind: 'premium', months}} data-flx="premium.premium-plan-card.checkout-modal" />
		)),
	);
}

interface PremiumPlanCardProps {
	entry: ShopPackageEntry;
	// The one package in the ribbon and the halo; every plan buys on the violet accent button.
	recommended: boolean;
	// A member buys more time ("Add time"), everyone else buys ("Purchase").
	isPremium: boolean;
}

// A plan card with its picture. Prices are display only: the checkout shows the server's
// quote and the AZN amount the order is charged.
export const PremiumPlanCard = observer(({entry, recommended, isPremium}: PremiumPlanCardProps) => {
	const {i18n} = useLingui();
	const {price, months} = entry;
	const locale = i18n.locale;
	const sale = campaignShown(price, ShopCatalog.now());
	const cents = shownCents(price, ShopCatalog.now());

	const discount = sale ? formatDiscount(price.campaign_percent ?? 0, locale) : null;
	// What a month of this package saves against the one month package, from the prices on sale now.
	const savingsPercent = planSavingsPercent(entry, ShopCatalog.packageEntries, ShopCatalog.now());
	const savings =
		savingsPercent === null
			? null
			: i18n._(SAVE_VS_MONTHLY_DESCRIPTOR, {
					percent: getCachedNumberFormat(locale, {style: 'percent'}).format(savingsPercent / 100),
				});

	const button = (
		<Button fitContainer={true} onClick={() => openCheckout(months)} data-flx="premium.premium-plan-card.button.select">
			{i18n._(isPremium ? ADD_TIME_DESCRIPTOR : PURCHASE_DESCRIPTOR)}
		</Button>
	);
	return (
		<div className={clsx(styles.card, recommended && styles.recommended)} data-flx="premium.premium-plan-card.card">
			<div className={styles.art} aria-hidden="true" data-flx="premium.premium-plan-card.art">
				<img
					className={styles.artImage}
					src={PLAN_ART[planArt(months)]}
					alt=""
					loading="lazy"
					decoding="async"
					draggable={false}
					data-flx="premium.premium-plan-card.art-image"
				/>
			</div>
			{recommended && (
				<span className={styles.ribbon} data-flx="premium.premium-plan-card.ribbon">
					{i18n._(RECOMMENDED_DESCRIPTOR)}
				</span>
			)}
			<h3 className={styles.title} data-flx="premium.premium-plan-card.title">
				{i18n._(PACKAGE_MONTHS_DESCRIPTOR, {months})}
			</h3>
			<div className={styles.priceRow} data-flx="premium.premium-plan-card.price-row">
				<span className={styles.price} data-flx="premium.premium-plan-card.price">
					<ShopPrice cents={cents} months={months} />
				</span>
				{discount !== null && (
					<>
						<span className={styles.srOnly} data-flx="premium.premium-plan-card.was-label">
							<ShopPrice cents={price.base_usd_cents} months={months} primaryOnly label={WAS_PRICE_DESCRIPTOR} />
						</span>
						<s className={styles.was} aria-hidden data-flx="premium.premium-plan-card.was">
							<ShopPrice cents={price.base_usd_cents} months={months} primaryOnly />
						</s>
						<span className={styles.srOnly} data-flx="premium.premium-plan-card.discount-label">
							{i18n._(DISCOUNT_PERCENT_DESCRIPTOR, {percent: discount})}
						</span>
						<span className={styles.discount} aria-hidden data-flx="premium.premium-plan-card.discount">
							{discount}
						</span>
					</>
				)}
				{savings !== null && (
					<span className={styles.savings} data-flx="premium.premium-plan-card.savings">
						{savings}
					</span>
				)}
			</div>
			<ul className={styles.perks} data-flx="premium.premium-plan-card.perks">
				{[
					i18n._(ALL_PERKS_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME}),
					i18n._(DOES_NOT_RENEW_DESCRIPTOR),
				].map((perk) => (
					<li key={perk} className={styles.perk} data-flx="premium.premium-plan-card.perk">
						<CheckIcon
							className={styles.perkIcon}
							weight="bold"
							aria-hidden
							data-flx="premium.premium-plan-card.perk-icon"
						/>
						{perk}
					</li>
				))}
			</ul>
			{sale && price.campaign_ends_at && (
				<div className={styles.countdown} data-flx="premium.premium-plan-card.countdown">
					<ShopCountdown
						endsAt={price.campaign_ends_at}
						size="card"
						data-flx="premium.premium-plan-card.shop-countdown"
					/>
				</div>
			)}
			<div className={styles.action} data-flx="premium.premium-plan-card.action">
				{recommended ? (
					<PremiumHalo size="large" className={styles.halo} data-flx="premium.premium-plan-card.halo">
						{button}
					</PremiumHalo>
				) : (
					button
				)}
			</div>
		</div>
	);
});
