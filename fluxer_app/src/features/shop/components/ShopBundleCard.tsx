// SPDX-License-Identifier: AGPL-3.0-or-later

import {PurchaseDisabledWrapper} from '@app/features/app/components/dialogs/components/plutonium/PurchaseDisabledWrapper';
import {useHover} from '@app/features/app/hooks/useHover';
import {useMergeRefs} from '@app/features/app/hooks/useMergeRefs';
import {PremiumHalo} from '@app/features/premium/components/PremiumHalo';
import {ShopBundleDetailModal} from '@app/features/shop/components/modals/ShopBundleDetailModal';
import {ShopCheckoutModal} from '@app/features/shop/components/modals/ShopCheckoutModal';
import styles from '@app/features/shop/components/ShopItemCard.module.css';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import {ShopPrice} from '@app/features/shop/components/ShopPrice';
import {cardPayCents, ShopPriceLine} from '@app/features/shop/components/ShopPriceLine';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import type {ShopBundleEntry} from '@app/features/shop/utils/ShopEntries';
import {
	ownsShopItem,
	purchaseBlockOf,
	resolveShopBundleAction,
	type ShopBundleAction,
} from '@app/features/shop/utils/ShopItemAction';
import {
	BUNDLE_CARD_TITLE_DESCRIPTOR,
	BUY_ALL_IN_SET_DESCRIPTOR,
	BUY_FOR_PRICE_DESCRIPTOR,
	BUY_ITEM_DESCRIPTOR,
	CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR,
	DISCOUNT_PERCENT_DESCRIPTOR,
	VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {formatDiscount} from '@app/features/shop/utils/ShopPriceFormat';
import {openShopSet} from '@app/features/shop/utils/ShopSetNavigation';
import {bundleSavingsPercent} from '@app/features/shop/utils/ShopSets';
import {Button, type ButtonVariant} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import Users from '@app/features/user/state/Users';
import {getCurrentLocale} from '@app/features/user/utils/LocaleUtils';
import type {MessageDescriptor} from '@lingui/core';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useRef} from 'react';

const PURCHASE_DESCRIPTOR = msg({
	message: 'Purchase',
	comment: 'Button on a shop bundle card that opens the buy dialog for the bundle.',
});

// The bundle purchase rules, read where the card and the collection header both ask.
function bundleActionOf(entry: ShopBundleEntry): ShopBundleAction {
	return resolveShopBundleAction({
		entry,
		ownedCount: entry.bundle.items.filter(ownsShopItem).length,
		itemSalesOpen: ShopCatalog.settings?.item_sales_open ?? false,
		purchaseBlock: purchaseBlockOf(Users.currentUser),
	});
}

function openBundleCheckout(entry: ShopBundleEntry): void {
	ModalCommands.push(
		modal(() => (
			<ShopCheckoutModal
				target={{kind: 'bundle', sku: entry.sku}}
				data-flx="shop.shop-bundle-card.shop-checkout-modal"
			/>
		)),
	);
}

interface ShopBundleCardProps {
	entry: ShopBundleEntry;
	// On its set's page the card opens the bundle's dialog; elsewhere it opens the set's page.
	opensDetails?: boolean;
}

// A wide card with every item of the bundle on it. The card opens the set or the bundle's dialog; the separate action
// retains the bundle purchase rules.
export const ShopBundleCard = observer(function ShopBundleCard({entry, opensDetails = false}: ShopBundleCardProps) {
	const {i18n} = useLingui();
	const cardRef = useRef<HTMLDivElement>(null);
	// The bundle's nameplate, over the card's foot, plays only while the card is hovered.
	const [hoverRef, hovering] = useHover();
	const rootRef = useMergeRefs<HTMLDivElement>([cardRef, hoverRef]);
	const {bundle} = entry;
	const action = bundleActionOf(entry);
	const open = () => {
		if (!opensDetails) {
			openShopSet(bundle.id);
			return;
		}
		ModalCommands.pushWithKey(
			modal(() => <ShopBundleDetailModal entry={entry} />),
			`shop-bundle-${bundle.id}`,
		);
	};
	const buyLabel = i18n._(BUY_ITEM_DESCRIPTOR, {name: bundle.name});
	const pay = cardPayCents(entry.price);
	// The saving shows beside a price only: not when the card says Owned or Not on sale instead.
	const savings =
		action.kind === 'none' ? null : bundleSavingsPercent(entry, ShopCatalog.itemEntries, ShopCatalog.now());
	const savingsText = savings === null ? null : formatDiscount(savings, getCurrentLocale());
	let actionButton: ReactNode = null;
	switch (action.kind) {
		case 'buy':
			actionButton = (
				<PremiumHalo size="small" className={styles.halo}>
					<Button
						fitContainer
						onClick={() => openBundleCheckout(entry)}
						aria-label={buyLabel}
						data-flx="shop.shop-bundle-card.button.action-buy"
					>
						{pay === null ? (
							i18n._(PURCHASE_DESCRIPTOR)
						) : (
							<ShopPrice
								cents={pay}
								label={BUY_FOR_PRICE_DESCRIPTOR}
								primaryOnly
								data-flx="shop.shop-bundle-card.buy-for-price"
							/>
						)}
					</Button>
				</PremiumHalo>
			);
			break;
		case 'buy_disabled':
			actionButton = (
				<PurchaseDisabledWrapper
					disabled
					tooltipText={i18n._(
						action.reason === 'unclaimed' ? CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR : VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
					)}
					data-flx="shop.shop-bundle-card.purchase-disabled-wrapper"
				>
					<Button
						fitContainer
						disabled
						aria-label={buyLabel}
						data-flx="shop.shop-bundle-card.button.action-buy-disabled"
					>
						{i18n._(PURCHASE_DESCRIPTOR)}
					</Button>
				</PurchaseDisabledWrapper>
			);
			break;
		case 'none':
			break;
	}
	return (
		<div
			ref={rootRef}
			className={clsx(styles.card, actionButton && styles.hasAction)}
			data-type="bundle"
			role="listitem"
			data-flx="shop.shop-bundle-card.card"
		>
			<ShopItemStage
				items={bundle.items}
				size="grid"
				composed
				animateNameplate={hovering}
				data-flx="shop.shop-bundle-card.shop-item-stage"
			/>
			<FocusRing offset={-2} ringTarget={cardRef} data-flx="shop.shop-bundle-card.focus-ring">
				<button
					type="button"
					className={styles.cardButton}
					onClick={open}
					data-shop-set-opener={opensDetails ? undefined : bundle.id}
					data-flx="shop.shop-bundle-card.card-button.open"
				>
					<span className={styles.name} data-flx="shop.shop-bundle-card.name">
						{i18n._(BUNDLE_CARD_TITLE_DESCRIPTOR, {count: bundle.items.length, name: bundle.name})}
					</span>
					<span className={styles.priceRow} data-flx="shop.shop-bundle-card.price-row">
						<ShopPriceLine entry={entry} size="card" data-flx="shop.shop-bundle-card.shop-price-line" />
						{savingsText !== null && (
							<>
								<span className={styles.srOnly} data-flx="shop.shop-bundle-card.savings-label">
									{i18n._(DISCOUNT_PERCENT_DESCRIPTOR, {percent: savingsText})}
								</span>
								<span className={styles.savings} aria-hidden data-flx="shop.shop-bundle-card.savings">
									{savingsText}
								</span>
							</>
						)}
					</span>
				</button>
			</FocusRing>
			{actionButton && (
				<div className={styles.action} data-flx="shop.shop-bundle-card.action">
					{actionButton}
				</div>
			)}
		</div>
	);
});

interface ShopBundleBuyButtonProps {
	entry: ShopBundleEntry;
	variant?: ButtonVariant;
	// Takes {name}, the set's name.
	label?: MessageDescriptor;
}

// The collection header's "Buy all: <set>": the same purchase as the bundle card's, under the same rules. Nothing
// when the bundle cannot be bought.
export const ShopBundleBuyButton = observer(function ShopBundleBuyButton({
	entry,
	variant = 'secondary',
	label: labelDescriptor = BUY_ALL_IN_SET_DESCRIPTOR,
}: ShopBundleBuyButtonProps) {
	const {i18n} = useLingui();
	const action = bundleActionOf(entry);
	const label = i18n._(labelDescriptor, {name: entry.bundle.name});
	switch (action.kind) {
		case 'buy':
			return (
				<Button
					variant={variant}
					onClick={() => openBundleCheckout(entry)}
					data-flx="shop.shop-bundle-card.shop-bundle-buy-button.button.buy"
				>
					{label}
				</Button>
			);
		case 'buy_disabled':
			return (
				<PurchaseDisabledWrapper
					disabled
					tooltipText={i18n._(
						action.reason === 'unclaimed' ? CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR : VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
					)}
					data-flx="shop.shop-bundle-card.shop-bundle-buy-button.purchase-disabled-wrapper"
				>
					<Button
						variant={variant}
						disabled
						data-flx="shop.shop-bundle-card.shop-bundle-buy-button.button.buy-disabled"
					>
						{label}
					</Button>
				</PurchaseDisabledWrapper>
			);
		case 'none':
			return null;
	}
});
