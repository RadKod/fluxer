// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {useHover} from '@app/features/app/hooks/useHover';
import {useMergeRefs} from '@app/features/app/hooks/useMergeRefs';
import Cosmetics, {type CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import {
	GET_PREMIUM_DESCRIPTOR,
	SOMETHING_WENT_WRONG_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {PremiumHalo} from '@app/features/premium/components/PremiumHalo';
import {ShopCheckoutModal, type ShopCheckoutTarget} from '@app/features/shop/components/modals/ShopCheckoutModal';
import {ShopItemDetailModal} from '@app/features/shop/components/modals/ShopItemDetailModal';
import {PurchaseDisabledWrapper} from '@app/features/shop/components/PurchaseDisabledWrapper';
import styles from '@app/features/shop/components/ShopItemCard.module.css';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import {ShopPrice} from '@app/features/shop/components/ShopPrice';
import {cardPayTryMinor, ShopPriceLine} from '@app/features/shop/components/ShopPriceLine';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import type {ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import {ownsShopItem, purchaseBlockOf, resolveShopItemAction} from '@app/features/shop/utils/ShopItemAction';
import {
	BUY_FOR_PRICE_DESCRIPTOR,
	BUY_ITEM_DESCRIPTOR,
	CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR,
	EQUIP_DESCRIPTOR,
	EQUIP_ITEM_DESCRIPTOR,
	EQUIPPED_BUTTON_DESCRIPTOR,
	INCLUDED_IN_PREMIUM_DESCRIPTOR,
	OWNED_DESCRIPTOR,
	VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import Users from '@app/features/user/state/Users';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckIcon, CrownIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useRef, useState} from 'react';

const PURCHASE_DESCRIPTOR = msg({
	message: 'Purchase',
	comment: 'Button on a shop card that opens the buy dialog for the item.',
});

interface ShopItemCardProps {
	entry: ShopItemEntry;
}

// DiscoveryGuildCard pattern: the card button opens the item dialog and the action button sits beside it, never
// inside it. The stage is a sibling under the button's full-card hit area, so no button nests inside another.
export const ShopItemCard = observer(function ShopItemCard({entry}: ShopItemCardProps) {
	const {i18n} = useLingui();
	const cardRef = useRef<HTMLDivElement>(null);
	// A nameplate on the stage plays only while the card is hovered.
	const [hoverRef, hovering] = useHover();
	const rootRef = useMergeRefs<HTMLDivElement>([cardRef, hoverRef]);
	const [equipping, setEquipping] = useState(false);
	const {item} = entry;
	const type = item.type as CosmeticType;
	const user = Users.currentUser;
	const owned = ownsShopItem(item);
	const settings = ShopCatalog.settings;
	const action = resolveShopItemAction({
		entry,
		owned,
		equipped: Cosmetics.equippedId(type) === item.id,
		isPremium: user?.isPremium() ?? false,
		itemSalesOpen: settings?.item_sales_open ?? false,
		premiumSalesOpen: settings?.premium_sales_open ?? false,
		purchaseBlock: purchaseBlockOf(user),
	});
	const openDetails = () =>
		ModalCommands.pushWithKey(
			modal(() => <ShopItemDetailModal entry={entry} data-flx="shop.shop-item-card.shop-item-detail-modal" />),
			`shop-item-${item.id}`,
		);
	const openCheckout = (target: ShopCheckoutTarget) =>
		ModalCommands.push(
			modal(() => <ShopCheckoutModal target={target} data-flx="shop.shop-item-card.shop-checkout-modal" />),
		);
	const buy = () => openCheckout({kind: 'item', sku: entry.sku});
	// Opens on the first package the catalog sells; the dialog lets the user pick another.
	const getPremium = () =>
		openCheckout({kind: 'premium', months: ShopCatalog.packageEntries[0]?.months ?? 1, fromItem: item});
	// One request at a time: every equip fans the user change out to all of their communities.
	const equip = async () => {
		setEquipping(true);
		try {
			await Cosmetics.equip({[type]: item.id});
		} catch {
			ToastCommands.createToast({type: 'error', children: i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR)});
		} finally {
			setEquipping(false);
		}
	};
	const buyLabel = i18n._(BUY_ITEM_DESCRIPTOR, {name: item.name});
	const pay = entry.price ? cardPayTryMinor(entry.price) : null;
	let actionButton: ReactNode = null;
	switch (action.kind) {
		case 'buy':
			actionButton = (
				<PremiumHalo size="small" className={styles.halo}>
					<Button fitContainer onClick={buy} aria-label={buyLabel} data-flx="shop.shop-item-card.button.action-buy">
						{pay === null ? (
							i18n._(PURCHASE_DESCRIPTOR)
						) : (
							<ShopPrice
								tryMinor={pay}
								label={BUY_FOR_PRICE_DESCRIPTOR}
								primaryOnly
								data-flx="shop.shop-item-card.buy-for-price"
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
					data-flx="shop.shop-item-card.purchase-disabled-wrapper"
				>
					<Button fitContainer disabled aria-label={buyLabel} data-flx="shop.shop-item-card.button.action-buy-disabled">
						{i18n._(PURCHASE_DESCRIPTOR)}
					</Button>
				</PurchaseDisabledWrapper>
			);
			break;
		case 'equip':
			actionButton = (
				<Button
					fitContainer
					variant="secondary"
					submitting={equipping}
					onClick={equip}
					aria-label={i18n._(EQUIP_ITEM_DESCRIPTOR, {name: item.name})}
					data-flx="shop.shop-item-card.button.action-equip"
				>
					{i18n._(EQUIP_DESCRIPTOR)}
				</Button>
			);
			break;
		case 'equipped':
			actionButton = (
				<Button
					fitContainer
					variant="secondary"
					disabled
					leftIcon={<CheckIcon weight="bold" data-flx="shop.shop-item-card.equipped-check-icon" />}
					data-flx="shop.shop-item-card.button.action-equipped"
				>
					{i18n._(EQUIPPED_BUTTON_DESCRIPTOR)}
				</Button>
			);
			break;
		case 'get_premium':
			actionButton = (
				<PremiumHalo size="small" className={styles.halo}>
					<Button fitContainer onClick={getPremium} data-flx="shop.shop-item-card.button.action-get-premium">
						{i18n._(GET_PREMIUM_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
					</Button>
				</PremiumHalo>
			);
			break;
		case 'none':
			break;
	}
	return (
		<div
			ref={rootRef}
			className={clsx(styles.card, actionButton && styles.hasAction)}
			data-type={item.type}
			role="listitem"
			data-flx="shop.shop-item-card.card"
		>
			<ShopItemStage
				items={[item]}
				size="grid"
				animateNameplate={hovering}
				data-flx="shop.shop-item-card.shop-item-stage"
			/>
			<FocusRing offset={-2} ringTarget={cardRef} data-flx="shop.shop-item-card.focus-ring">
				<button
					type="button"
					className={styles.cardButton}
					onClick={openDetails}
					data-flx="shop.shop-item-card.card-button.open"
				>
					{/* The price row says the same words; the stage chip is only seen, so it is read once. */}
					{owned ? (
						<span className={clsx(styles.chip, styles.chipOwned)} aria-hidden data-flx="shop.shop-item-card.chip">
							<CheckIcon
								className={styles.chipIcon}
								weight="bold"
								aria-hidden
								data-flx="shop.shop-item-card.chip-check-icon"
							/>
							{i18n._(OWNED_DESCRIPTOR)}
						</span>
					) : (
						item.availability === 'premium' && (
							<span className={clsx(styles.chip, styles.chipPremium)} aria-hidden data-flx="shop.shop-item-card.chip">
								<CrownIcon
									className={clsx(styles.chipIcon, styles.crown)}
									weight="fill"
									aria-hidden
									data-flx="shop.shop-item-card.chip-crown-icon"
								/>
								{i18n._(INCLUDED_IN_PREMIUM_DESCRIPTOR)}
							</span>
						)
					)}
					<span className={styles.name} data-flx="shop.shop-item-card.name">
						{item.name}
					</span>
					<ShopPriceLine entry={entry} size="card" data-flx="shop.shop-item-card.shop-price-line" />
				</button>
			</FocusRing>
			{actionButton && (
				<div className={styles.action} data-flx="shop.shop-item-card.action">
					{actionButton}
				</div>
			)}
		</div>
	);
});
