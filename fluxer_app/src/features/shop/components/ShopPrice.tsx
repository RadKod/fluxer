// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/shop/components/ShopPrice.module.css';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {
	aznMinorToTryMinor,
	formatAzn,
	formatTry,
	usdCentsToAznMinor,
	usdToAznRateMicro,
} from '@app/features/shop/utils/ShopPriceFormat';
import type {ShopOrderResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const PAYABLE_DESCRIPTOR = msg({
	message: 'Payable: {amount} AZN',
	comment: 'Exact total charged by Payriff, under the informational TL price.',
});
const MONTHLY_DESCRIPTOR = msg({
	message: '{price} a month',
	comment: 'Monthly TL equivalent of a sanalyer Plus package; the AZN amount below is the full package total.',
});
const DAILY_DESCRIPTOR = msg({
	message: '≈ {price} a day',
	comment: 'Informational daily TL equivalent of a sanalyer Plus package, using 30 days per month.',
});

interface ShopPriceProps {
	cents?: number;
	// Checkout passes the authoritative quote, never recalculates the payable total from catalog settings.
	aznMinor?: number;
	// Discounts subtract rounded cumulative levels in both currencies, so the displayed rows add up.
	subtractAznMinor?: number;
	months?: number;
	primaryOnly?: boolean;
	label?: MessageDescriptor;
	// Once an order exists, use its frozen display quote rather than the current catalog rate.
	displayQuote?: ShopOrderResponse;
}

// Reusable by shop cards, hero, plan comparison and checkout; no network calls or timers per price.
export const ShopPrice = observer(
	({cents, aznMinor, subtractAznMinor = 0, months, primaryOnly = false, label, displayQuote}: ShopPriceProps) => {
		const {i18n} = useLingui();
		const settings = ShopCatalog.settings;
		const rate = usdToAznRateMicro(settings);
		const amount = aznMinor ?? (cents != null && rate !== null ? usdCentsToAznMinor(cents, rate) : null);
		if (amount === null) return null;
		const locale = i18n.locale;
		const tryRate = displayQuote
			? displayQuote.display_currency === 'TRY'
				? displayQuote.display_rate_micro
				: null
			: settings?.try_to_azn_rate_micro;
		const converted =
			displayQuote?.display_currency === 'TRY' && amount === displayQuote.amount_azn_minor
				? (displayQuote.display_amount_minor ?? null)
				: aznMinorToTryMinor(amount, tryRate);
		const convertedSubtract = subtractAznMinor === 0 ? 0 : aznMinorToTryMinor(subtractAznMinor, tryRate);
		const tryMinor = converted === null || convertedSubtract === null ? null : converted - convertedSubtract;
		const difference = amount - subtractAznMinor;
		const monthly = tryMinor === null ? null : Math.round(tryMinor / (months ?? 1));
		const primary = monthly === null ? `${formatAzn(difference, locale)} AZN` : formatTry(monthly, locale);
		const price = months && monthly !== null ? i18n._(MONTHLY_DESCRIPTOR, {price: primary}) : primary;
		return (
			<span className={styles.price} data-flx="shop.shop-price.price">
				<span data-flx="shop.shop-price.primary">{label ? i18n._(label, {price}) : price}</span>
				{!primaryOnly && months && monthly !== null && (
					<span className={styles.note} data-flx="shop.shop-price.daily">
						{i18n._(DAILY_DESCRIPTOR, {price: formatTry(Math.round(monthly / 30), locale)})}
					</span>
				)}
				{!primaryOnly && tryMinor !== null && (
					<span className={styles.note} data-flx="shop.shop-price.payable">
						{i18n._(PAYABLE_DESCRIPTOR, {amount: formatAzn(difference, locale)})}
					</span>
				)}
			</span>
		);
	},
);
