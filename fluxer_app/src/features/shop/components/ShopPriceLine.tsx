// SPDX-License-Identifier: AGPL-3.0-or-later

import {ShopCountdown} from '@app/features/shop/components/ShopCountdown';
import {ShopPrice} from '@app/features/shop/components/ShopPrice';
import styles from '@app/features/shop/components/ShopPriceLine.module.css';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import type {ShopEntry} from '@app/features/shop/utils/ShopEntries';
import {ownsShopItem} from '@app/features/shop/utils/ShopItemAction';
import {
	BUNDLE_ITEM_OWNED_DESCRIPTOR,
	DISCOUNT_PERCENT_DESCRIPTOR,
	INCLUDED_IN_PREMIUM_DESCRIPTOR,
	NOT_ON_SALE_DESCRIPTOR,
	OWNED_DESCRIPTOR,
	WAS_PRICE_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {campaignShown, formatDiscount, percentOff, shownTryMinor} from '@app/features/shop/utils/ShopPriceFormat';
import Tick from '@app/features/ui/state/Tick';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import type {ShopPriceResponse} from '@fluxer/schema/src/domains/shop/ShopResponseSchemas';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CrownIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';

const WITH_MICUP_PLUS_DESCRIPTOR = msg({
	message: '{price} with sanalyer Plus',
	comment: 'Secondary shop price for someone without the sanalyer Plus discount. {price} is a price in Turkish lira.',
});

export interface ShownPrice {
	saleTryMinor: number;
	premiumTryMinor: number | null;
	campaignPercent: number | null;
	endsAt: string | null;
}

// Card prices are display only: the buy dialog shows the server's quote. A campaign that ended since the catalog was
// read is dropped here and the member price redrawn on the list price, rounded half up like the server.
export function shownPrice(price: ShopPriceResponse, premiumPercent: number, now: number): ShownPrice {
	const saleTryMinor = shownTryMinor(price, now);
	if (campaignShown(price, now)) {
		return {
			saleTryMinor,
			premiumTryMinor: price.premium_try_minor,
			campaignPercent: price.campaign_percent,
			endsAt: price.campaign_ends_at,
		};
	}
	return {
		saleTryMinor,
		premiumTryMinor: price.premium_try_minor === null ? null : percentOff(saleTryMinor, premiumPercent),
		campaignPercent: null,
		endsAt: null,
	};
}

// What the viewer pays for a priced item or bundle, as its card shows it: the member price when they get it.
export function cardPayTryMinor(price: ShopPriceResponse): number | null {
	const settings = ShopCatalog.settings;
	if (!settings) return null;
	const shown = shownPrice(price, settings.premium_discount_percent, ShopCatalog.now());
	return (ShopCatalog.premiumDiscount ? shown.premiumTryMinor : null) ?? shown.saleTryMinor;
}

interface ShopPriceLineProps {
	entry: ShopEntry;
	size: 'card' | 'dialog';
}

// The price rows of docs/magaza/tasarim.md the price the viewer pays, the premium row, the campaign countdown.
export const ShopPriceLine = observer(function ShopPriceLine({entry, size}: ShopPriceLineProps) {
	const {i18n} = useLingui();
	const settings = ShopCatalog.settings;
	const card = size === 'card';
	if (entry.kind === 'item' && ownsShopItem(entry.item)) {
		return card ? <CardStatus text={i18n._(OWNED_DESCRIPTOR)} data-flx="shop.shop-price-line.card-status" /> : null;
	}
	// A bundle with an item the account has is not sold: the card says so instead of a price.
	if (entry.kind === 'bundle') {
		const owned = entry.bundle.items.filter(ownsShopItem).length;
		if (owned > 0) {
			const text = i18n._(owned >= entry.bundle.items.length ? OWNED_DESCRIPTOR : BUNDLE_ITEM_OWNED_DESCRIPTOR);
			return card ? <CardStatus text={text} data-flx="shop.shop-price-line.card-status" /> : null;
		}
	}
	if (entry.kind === 'item' && entry.item.availability === 'premium') {
		if (card) {
			return <CardStatus text={i18n._(INCLUDED_IN_PREMIUM_DESCRIPTOR)} data-flx="shop.shop-price-line.card-status" />;
		}
		return (
			<span className={clsx(styles.note, styles.included)} data-flx="shop.shop-price-line.note">
				{i18n._(INCLUDED_IN_PREMIUM_DESCRIPTOR)}
			</span>
		);
	}
	const salesOpen = entry.kind === 'package' ? settings?.premium_sales_open : settings?.item_sales_open;
	if (!settings || !salesOpen || !entry.price) {
		if (card) {
			return <CardStatus text={i18n._(NOT_ON_SALE_DESCRIPTOR)} muted data-flx="shop.shop-price-line.card-status" />;
		}
		return (
			<span className={clsx(styles.note, styles.notOnSale)} data-flx="shop.shop-price-line.note">
				{i18n._(NOT_ON_SALE_DESCRIPTOR)}
			</span>
		);
	}
	// Redraws once a minute while a dated campaign runs; its countdown keeps the shared tick going.
	if (entry.price.campaign_ends_at) void Tick.nowMinute;
	const locale = getCurrentLocale();
	const shown = shownPrice(entry.price, settings.premium_discount_percent, ShopCatalog.now());
	const base = entry.price.base_try_minor;
	const premium = shown.premiumTryMinor;
	// viewer.premium_discount, not the user's premium type: a trial may wear premium items but pays the list price.
	const memberPrice = ShopCatalog.premiumDiscount ? premium : null;
	const discount = shown.campaignPercent === null ? null : formatDiscount(shown.campaignPercent, locale);
	if (card) {
		// One row, as on a shop shelf: the price the viewer pays, the struck list price and the sale. The Plus price and
		// the countdown are in the item's dialog.
		return (
			<span className={styles.card} data-flx="shop.shop-price-line.price-line">
				<span className={styles.cardRow} data-flx="shop.shop-price-line.row">
					<span className={styles.cardFinal} data-flx="shop.shop-price-line.final">
						<ShopPrice
							tryMinor={memberPrice ?? shown.saleTryMinor}
							primaryOnly
							data-flx="shop.shop-price-line.shop-price"
						/>
					</span>
					<PriceExtras
						base={base}
						struck={memberPrice !== null || discount !== null}
						discount={discount}
						wasClassName={styles.cardWas}
						badgeClassName={styles.cardBadge}
						data-flx="shop.shop-price-line.price-extras"
					/>
				</span>
			</span>
		);
	}
	return (
		<span className={clsx(styles.priceLine, styles.dialog)} data-flx="shop.shop-price-line.price-line">
			<span className={styles.row} data-flx="shop.shop-price-line.row">
				<span className={styles.final} data-flx="shop.shop-price-line.final">
					{memberPrice === null ? (
						<ShopPrice tryMinor={shown.saleTryMinor} data-flx="shop.shop-price-line.shop-price--3" />
					) : (
						<>
							<CrownIcon
								className={styles.crown}
								weight="fill"
								aria-hidden
								data-flx="shop.shop-price-line.crown-icon"
							/>
							<ShopPrice tryMinor={memberPrice} data-flx="shop.shop-price-line.shop-price--4" />
						</>
					)}
				</span>
				<PriceExtras
					base={base}
					struck={memberPrice !== null || discount !== null}
					discount={discount}
					wasClassName={styles.was}
					badgeClassName={styles.badge}
					data-flx="shop.shop-price-line.price-extras--2"
				/>
			</span>
			{premium !== null && memberPrice === null && (
				<span className={styles.premium} data-flx="shop.shop-price-line.premium">
					<CrownIcon
						className={styles.crown}
						weight="fill"
						aria-hidden
						data-flx="shop.shop-price-line.premium-crown-icon"
					/>
					<ShopPrice
						tryMinor={premium}
						label={WITH_MICUP_PLUS_DESCRIPTOR}
						primaryOnly
						data-flx="shop.shop-price-line.shop-price--5"
					/>
				</span>
			)}
			{shown.endsAt && (
				<ShopCountdown endsAt={shown.endsAt} size={size} data-flx="shop.shop-price-line.shop-countdown" />
			)}
		</span>
	);
});

interface PriceExtrasProps {
	base: number;
	// The list price is struck through whenever the price shown is lower (a campaign or the member price).
	struck: boolean;
	discount: string | null;
	wasClassName: string;
	badgeClassName: string;
}

// After the price: the struck list price and the campaign badge, each read once through its hidden label.
function PriceExtras({base, struck, discount, wasClassName, badgeClassName}: PriceExtrasProps) {
	const {i18n} = useLingui();
	return (
		<>
			{struck && (
				<>
					<span className={styles.srOnly} data-flx="shop.shop-price-line.was-label">
						<ShopPrice
							tryMinor={base}
							primaryOnly
							label={WAS_PRICE_DESCRIPTOR}
							data-flx="shop.shop-price-line.price-extras.shop-price"
						/>
					</span>
					<s className={wasClassName} aria-hidden data-flx="shop.shop-price-line.was">
						<ShopPrice tryMinor={base} primaryOnly data-flx="shop.shop-price-line.price-extras.shop-price--2" />
					</s>
				</>
			)}
			{discount !== null && (
				<>
					<span className={styles.srOnly} data-flx="shop.shop-price-line.badge-label">
						{i18n._(DISCOUNT_PERCENT_DESCRIPTOR, {percent: discount})}
					</span>
					<span className={badgeClassName} aria-hidden data-flx="shop.shop-price-line.badge">
						{discount}
					</span>
				</>
			)}
		</>
	);
}

// The card's price row with a word instead of a price (Owned, Included in Plus, Not on sale), in the same markup as a
// priced card.
function CardStatus({text, muted = false}: {text: string; muted?: boolean}) {
	return (
		<span className={styles.card} data-flx="shop.shop-price-line.price-line">
			<span className={styles.cardRow} data-flx="shop.shop-price-line.row">
				<span className={clsx(styles.status, muted && styles.statusMuted)} data-flx="shop.shop-price-line.status">
					{text}
				</span>
			</span>
		</span>
	);
}
