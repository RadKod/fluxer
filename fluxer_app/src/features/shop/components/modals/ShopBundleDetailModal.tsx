// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import {COSMETIC_TYPE_LABELS} from '@app/features/cosmetics/utils/CosmeticLabels';
import {CLOSE_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import {ShopCheckoutModal} from '@app/features/shop/components/modals/ShopCheckoutModal';
import styles from '@app/features/shop/components/modals/ShopItemDetailModal.module.css';
import {PurchaseDisabledWrapper} from '@app/features/shop/components/PurchaseDisabledWrapper';
import {ShopDetailPreview} from '@app/features/shop/components/previews/ShopDetailPreview';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import {ShopPriceLine} from '@app/features/shop/components/ShopPriceLine';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import type {ShopBundleEntry} from '@app/features/shop/utils/ShopEntries';
import {ownsShopItem, purchaseBlockOf, resolveShopBundleAction} from '@app/features/shop/utils/ShopItemAction';
import {
	BUNDLE_ITEM_OWNED_DESCRIPTOR,
	CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR,
	OWNED_DESCRIPTOR,
	VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {isShopCosmeticType} from '@app/features/shop/utils/ShopSurfaces';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import Users from '@app/features/user/state/Users';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useRef} from 'react';

const PURCHASE_DESCRIPTOR = msg({message: 'Purchase', comment: 'Button that opens checkout for a shop bundle.'});
const INCLUDED_IN_BUNDLE_DESCRIPTOR = msg({
	message: 'Included in this bundle',
	comment: 'Heading above the items included in a shop bundle.',
});

export const ShopBundleDetailModal = observer(function ShopBundleDetailModal({entry}: {entry: ShopBundleEntry}) {
	const {i18n} = useLingui();
	const actionRef = useRef<HTMLButtonElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const user = Users.currentUser;
	const {bundle} = entry;
	const ownedCount = bundle.items.filter(ownsShopItem).length;
	const action = resolveShopBundleAction({
		entry,
		ownedCount,
		itemSalesOpen: ShopCatalog.settings?.item_sales_open ?? false,
		purchaseBlock: purchaseBlockOf(user),
	});
	if (!user) return null;
	const buy = () => {
		ModalCommands.push(
			ModalCommands.modal(() => (
				<ShopCheckoutModal
					target={{kind: 'bundle', sku: entry.sku}}
					data-flx="shop.shop-bundle-detail-modal.buy.shop-checkout-modal"
				/>
			)),
		);
	};
	return (
		<Modal.Root
			size="large"
			initialFocusRef={action.kind === 'buy' ? actionRef : closeRef}
			data-flx="shop.shop-bundle-detail-modal.modal-root"
		>
			<Modal.Header title={bundle.name} data-flx="shop.shop-bundle-detail-modal.modal-header" />
			<Modal.Content data-flx="shop.shop-bundle-detail-modal.modal-content">
				<div className={styles.layout} data-flx="shop.shop-bundle-detail-modal.layout">
					<div className={styles.product} data-flx="shop.shop-bundle-detail-modal.product">
						<ShopItemStage items={bundle.items} size="grid" data-flx="shop.shop-bundle-detail-modal.shop-item-stage" />
						{bundle.description && (
							<p className={styles.description} data-flx="shop.shop-bundle-detail-modal.description">
								{bundle.description}
							</p>
						)}
						<h2 className={styles.contentsTitle} data-flx="shop.shop-bundle-detail-modal.contents-title">
							{i18n._(INCLUDED_IN_BUNDLE_DESCRIPTOR)}
						</h2>
						<ul className={styles.contents} data-flx="shop.shop-bundle-detail-modal.contents">
							{bundle.items.map((item) => (
								<li key={item.id} data-flx="shop.shop-bundle-detail-modal.li">
									<span data-flx="shop.shop-bundle-detail-modal.span">{item.name}</span>
									{isShopCosmeticType(item.type) && (
										<span className={styles.itemType} data-flx="shop.shop-bundle-detail-modal.item-type">
											{i18n._(COSMETIC_TYPE_LABELS[item.type])}
										</span>
									)}
								</li>
							))}
						</ul>
						<div className={styles.purchase} data-flx="shop.shop-bundle-detail-modal.purchase">
							<ShopPriceLine entry={entry} size="dialog" data-flx="shop.shop-bundle-detail-modal.shop-price-line" />
							{action.kind === 'none' && (action.label === 'owned' || action.label === 'partly_owned') && (
								<p className={styles.note} data-flx="shop.shop-bundle-detail-modal.note">
									{i18n._(action.label === 'owned' ? OWNED_DESCRIPTOR : BUNDLE_ITEM_OWNED_DESCRIPTOR)}
								</p>
							)}
							{action.kind === 'buy' && (
								<Button ref={actionRef} onClick={buy} data-flx="shop.shop-bundle-detail-modal.button.buy">
									{i18n._(PURCHASE_DESCRIPTOR)}
								</Button>
							)}
							{action.kind === 'buy_disabled' && (
								<PurchaseDisabledWrapper
									disabled
									tooltipText={i18n._(
										action.reason === 'unclaimed' ? CLAIM_ACCOUNT_TO_BUY_DESCRIPTOR : VERIFY_EMAIL_TO_BUY_DESCRIPTOR,
									)}
									data-flx="shop.shop-bundle-detail-modal.purchase-disabled-wrapper"
								>
									<Button disabled data-flx="shop.shop-bundle-detail-modal.button">
										{i18n._(PURCHASE_DESCRIPTOR)}
									</Button>
								</PurchaseDisabledWrapper>
							)}
						</div>
					</div>
					<ShopDetailPreview
						items={bundle.items}
						user={user}
						data-flx="shop.shop-bundle-detail-modal.shop-detail-preview"
					/>
				</div>
			</Modal.Content>
			<Modal.Footer data-flx="shop.shop-bundle-detail-modal.modal-footer">
				<Button
					ref={closeRef}
					variant="secondary"
					onClick={ModalCommands.pop}
					data-flx="shop.shop-bundle-detail-modal.button.pop"
				>
					{i18n._(CLOSE_DESCRIPTOR)}
				</Button>
			</Modal.Footer>
		</Modal.Root>
	);
});
