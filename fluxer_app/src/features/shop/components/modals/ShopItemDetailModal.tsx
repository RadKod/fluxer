// SPDX-License-Identifier: AGPL-3.0-or-later

import {PurchaseDisabledWrapper} from '@app/features/app/components/dialogs/components/plutonium/PurchaseDisabledWrapper';
import * as Modal from '@app/features/app/components/dialogs/Modal';
import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import Cosmetics, {type CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import {COSMETIC_TYPE_LABELS} from '@app/features/cosmetics/utils/CosmeticLabels';
import {
	CLOSE_DESCRIPTOR,
	GET_PREMIUM_DESCRIPTOR,
	SOMETHING_WENT_WRONG_DESCRIPTOR,
} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {PremiumHalo} from '@app/features/premium/components/PremiumHalo';
import {ShopCheckoutModal, type ShopCheckoutTarget} from '@app/features/shop/components/modals/ShopCheckoutModal';
import styles from '@app/features/shop/components/modals/ShopItemDetailModal.module.css';
import {ShopDetailPreview} from '@app/features/shop/components/previews/ShopDetailPreview';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import {ShopPriceLine} from '@app/features/shop/components/ShopPriceLine';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import type {ShopItemEntry} from '@app/features/shop/utils/ShopEntries';
import {ownsShopItem, purchaseBlockOf, resolveShopItemAction} from '@app/features/shop/utils/ShopItemAction';
import {
	CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR,
	EQUIP_DESCRIPTOR,
	EQUIPPED_BUTTON_DESCRIPTOR,
	INCLUDED_IN_PREMIUM_DESCRIPTOR,
	OWNED_DESCRIPTOR,
	PREVIEW_TAKES_THE_PLACE_DESCRIPTOR,
	VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import * as ToastCommands from '@app/features/ui/commands/ToastCommands';
import {ModalStackContext} from '@app/features/ui/utils/ModalStackContext';
import Users from '@app/features/user/state/Users';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CheckIcon, CrownIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useContext, useEffect, useRef, useState} from 'react';

const PURCHASE_DESCRIPTOR = msg({
	message: 'Purchase',
	comment: 'Button in the shop item dialog that opens the buy dialog for the item.',
});
interface ShopItemDetailModalProps {
	entry: ShopItemEntry;
}

// The item on every surface the app draws its type on, side by side.
export const ShopItemDetailModal = observer<ShopItemDetailModalProps>(({entry}) => {
	const {i18n} = useLingui();
	const {isTopmost} = useContext(ModalStackContext);
	const actionRef = useRef<HTMLButtonElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const checkoutOpenRef = useRef(false);
	const [equipping, setEquipping] = useState(false);
	const {item} = entry;
	const type = item.type as CosmeticType;
	const user = Users.currentUser;
	const wornId = Cosmetics.equippedId(type);
	const owned = ownsShopItem(item);
	const action = user
		? resolveShopItemAction({
				entry,
				owned,
				equipped: wornId === item.id,
				isPremium: user.isPremium(),
				itemSalesOpen: ShopCatalog.settings?.item_sales_open ?? false,
				premiumSalesOpen: ShopCatalog.settings?.premium_sales_open ?? false,
				purchaseBlock: purchaseBlockOf(user),
			})
		: null;
	const wearable = action?.kind === 'equip' || action?.kind === 'equipped';
	// The checkout opens on top of this dialog. When a purchase ends with its Okay, this dialog closes too; the
	// settings under it stay open.
	useEffect(() => {
		if (!isTopmost || !checkoutOpenRef.current) return;
		checkoutOpenRef.current = false;
		if (wearable) ModalCommands.pop();
	}, [isTopmost, wearable]);
	if (!user || !action) return null;
	const openCheckout = (target: ShopCheckoutTarget) => {
		checkoutOpenRef.current = true;
		ModalCommands.push(
			ModalCommands.modal(() => (
				<ShopCheckoutModal target={target} data-flx="shop.shop-item-detail-modal.open-checkout.shop-checkout-modal" />
			)),
		);
	};
	const handleEquip = async () => {
		setEquipping(true);
		try {
			await Cosmetics.equip({[type]: item.id});
		} catch {
			ToastCommands.createToast({type: 'error', children: i18n._(SOMETHING_WENT_WRONG_DESCRIPTOR)});
		} finally {
			setEquipping(false);
		}
	};
	let actionButton: ReactNode = null;
	switch (action.kind) {
		case 'buy':
			actionButton = (
				<PremiumHalo size="small" className={styles.halo}>
					<Button
						ref={actionRef}
						onClick={() => openCheckout({kind: 'item', sku: entry.sku})}
						data-flx="shop.shop-item-detail-modal.button.buy"
					>
						{i18n._(PURCHASE_DESCRIPTOR)}
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
					data-flx="shop.shop-item-detail-modal.purchase-disabled-wrapper"
				>
					<Button disabled data-flx="shop.shop-item-detail-modal.button.buy-disabled">
						{i18n._(PURCHASE_DESCRIPTOR)}
					</Button>
				</PurchaseDisabledWrapper>
			);
			break;
		case 'equip':
			actionButton = (
				<Button
					ref={actionRef}
					variant="secondary"
					submitting={equipping}
					onClick={handleEquip}
					data-flx="shop.shop-item-detail-modal.button.equip"
				>
					{i18n._(EQUIP_DESCRIPTOR)}
				</Button>
			);
			break;
		case 'equipped':
			actionButton = (
				<Button
					variant="secondary"
					disabled
					leftIcon={<CheckIcon weight="bold" data-flx="shop.shop-item-detail-modal.equipped-icon" />}
					data-flx="shop.shop-item-detail-modal.button.equipped"
				>
					{i18n._(EQUIPPED_BUTTON_DESCRIPTOR)}
				</Button>
			);
			break;
		case 'get_premium':
			actionButton = (
				<Button
					ref={actionRef}
					onClick={() =>
						openCheckout({kind: 'premium', months: ShopCatalog.packageEntries[0]?.months ?? 1, fromItem: item})
					}
					data-flx="shop.shop-item-detail-modal.button.get-premium"
				>
					{i18n._(GET_PREMIUM_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
				</Button>
			);
			break;
	}
	const focusesAction = action.kind === 'buy' || action.kind === 'equip' || action.kind === 'get_premium';
	return (
		<Modal.Root
			size="large"
			initialFocusRef={focusesAction ? actionRef : closeRef}
			data-flx="shop.shop-item-detail-modal.modal-root"
		>
			<Modal.Header title={item.name} data-flx="shop.shop-item-detail-modal.modal-header" />
			<Modal.Content data-flx="shop.shop-item-detail-modal.modal-content">
				<div className={styles.layout} data-flx="shop.shop-item-detail-modal.layout">
					<div className={styles.product} data-flx="shop.shop-item-detail-modal.product">
						<ShopItemStage items={[item]} size="grid" />
						<div className={styles.intro} data-flx="shop.shop-item-detail-modal.intro">
							<span className={styles.chip} data-flx="shop.shop-item-detail-modal.type-chip">
								{i18n._(COSMETIC_TYPE_LABELS[type])}
							</span>
							{owned ? (
								<span className={clsx(styles.chip, styles.chipOwned)} data-flx="shop.shop-item-detail-modal.owned-chip">
									<CheckIcon weight="bold" aria-hidden data-flx="shop.shop-item-detail-modal.owned-icon" />
									{i18n._(OWNED_DESCRIPTOR)}
								</span>
							) : (
								item.availability === 'premium' && (
									<span
										className={clsx(styles.chip, styles.chipPremium)}
										data-flx="shop.shop-item-detail-modal.premium-chip"
									>
										<CrownIcon
											weight="fill"
											aria-hidden
											className={styles.crown}
											data-flx="shop.shop-item-detail-modal.crown-icon"
										/>
										{i18n._(INCLUDED_IN_PREMIUM_DESCRIPTOR)}
									</span>
								)
							)}
							{item.description && (
								<p className={styles.description} data-flx="shop.shop-item-detail-modal.description">
									{item.description}
								</p>
							)}
						</div>
						{wornId !== null && wornId !== item.id && (
							<p className={styles.note} data-flx="shop.shop-item-detail-modal.worn-note">
								{i18n._(PREVIEW_TAKES_THE_PLACE_DESCRIPTOR, {type: i18n._(COSMETIC_TYPE_LABELS[type])})}
							</p>
						)}
						<div className={styles.purchase}>
							<ShopPriceLine entry={entry} size="dialog" data-flx="shop.shop-item-detail-modal.price-line" />
							{actionButton}
						</div>
					</div>
					<ShopDetailPreview items={[item]} user={user} />
				</div>
			</Modal.Content>
			<Modal.Footer data-flx="shop.shop-item-detail-modal.modal-footer">
				<Button
					ref={closeRef}
					variant="secondary"
					onClick={ModalCommands.pop}
					data-flx="shop.shop-item-detail-modal.button.close"
				>
					{i18n._(CLOSE_DESCRIPTOR)}
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});
