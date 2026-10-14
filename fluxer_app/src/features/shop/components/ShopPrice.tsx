// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/shop/components/ShopPrice.module.css';
import {formatTry} from '@app/features/shop/utils/ShopPriceFormat';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const MONTHLY_DESCRIPTOR = msg({
	message: '{price} a month',
	comment: 'Monthly price of a sanalyer Plus package, in Turkish lira. The package total is charged at once.',
});
const DAILY_DESCRIPTOR = msg({
	message: '≈ {price} a day',
	comment: 'Approximate daily price of a sanalyer Plus package, in Turkish lira, using 30 days per month.',
});

const PACKAGE_TOTAL_DESCRIPTOR = msg({
	message: '{price} in total',
	comment:
		'Full price of a multi-month sanalyer Plus package, charged at once, in Turkish lira. Under the monthly price.',
});

interface ShopPriceProps {
	// sanalyer: every shop price is Turkish lira in kuruş. Checkout passes the server quote's numbers as they are.
	tryMinor: number;
	months?: number;
	primaryOnly?: boolean;
	label?: MessageDescriptor;
}

// Reusable by shop cards, hero, plan comparison and checkout; no network calls or timers per price.
export const ShopPrice = observer(({tryMinor, months, primaryOnly = false, label}: ShopPriceProps) => {
	const {i18n} = useLingui();
	const locale = i18n.locale;
	const monthly = Math.round(tryMinor / (months ?? 1));
	const primary = formatTry(monthly, locale);
	const price = months ? i18n._(MONTHLY_DESCRIPTOR, {price: primary}) : primary;
	return (
		<span className={styles.price} data-flx="shop.shop-price.price">
			<span data-flx="shop.shop-price.primary">{label ? i18n._(label, {price}) : price}</span>
			{!primaryOnly && months && (
				<span className={styles.note} data-flx="shop.shop-price.daily">
					{i18n._(DAILY_DESCRIPTOR, {price: formatTry(Math.round(monthly / 30), locale)})}
				</span>
			)}
			{/* sanalyer: the package total used to show as the AZN amount charged; in TRY it is the plain total. */}
			{!primaryOnly && months && months > 1 && (
				<span className={styles.note} data-flx="shop.shop-price.total">
					{i18n._(PACKAGE_TOTAL_DESCRIPTOR, {price: formatTry(tryMinor, locale)})}
				</span>
			)}
		</span>
	);
});
