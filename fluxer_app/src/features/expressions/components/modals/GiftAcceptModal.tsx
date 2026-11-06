// SPDX-License-Identifier: AGPL-3.0-or-later

import * as Modal from '@app/features/app/components/dialogs/Modal';
import Cosmetics, {type CosmeticType} from '@app/features/cosmetics/state/Cosmetics';
import {COSMETIC_TYPE_LABELS} from '@app/features/cosmetics/utils/CosmeticLabels';
import styles from '@app/features/expressions/components/modals/GiftAcceptModal.module.css';
import type {Gift} from '@app/features/gift/commands/GiftCommands';
import * as GiftCommands from '@app/features/gift/commands/GiftCommands';
import Gifts from '@app/features/gift/state/Gifts';
import {getGiftDurationText} from '@app/features/gift/utils/GiftUtils';
import {CLOSE_DESCRIPTOR, OKAY_DESCRIPTOR} from '@app/features/i18n/utils/CommonMessageDescriptors';
import type {InstanceHTTPTarget} from '@app/features/platform/transport/InstanceHTTP';
import {Logger} from '@app/features/platform/utils/AppLogger';
import {getPremiumProductName} from '@app/features/premium/utils/PremiumUtils';
import {ShopEquippedSuccess} from '@app/features/shop/components/ShopEquippedSuccess';
import {ShopItemStage} from '@app/features/shop/components/ShopItemStage';
import {
	ADDED_AND_EQUIPPED_DESCRIPTOR,
	ALREADY_OWNED_CODE_KEPT_DESCRIPTOR,
	CODE_GIVES_ITEM_DESCRIPTOR,
	REDEEM_AND_EQUIP_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {Spinner} from '@app/features/ui/components/Spinner';
import {User} from '@app/features/user/models/User';
import Users from '@app/features/user/state/Users';
import {getAccountGatePresentation} from '@app/features/user/utils/AccountGatePresentation';
import {canPerform} from '@app/features/user/utils/AccountGates';
import * as NicknameUtils from '@app/features/user/utils/NicknameUtils';
import {TierGatedActions} from '@fluxer/constants/src/AccountTierConstants';
import type {CosmeticItemResponse} from '@fluxer/schema/src/domains/cosmetics/CosmeticResponseSchemas';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {GiftIcon, QuestionIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import {type ReactNode, useEffect, useMemo, useState} from 'react';

const UNKNOWN_GIFT_DESCRIPTOR = msg({
	message: 'Unknown gift',
	comment: 'Title shown when a gift code is invalid or not found.',
});
const THIS_GIFT_CODE_IS_INVALID_OR_ALREADY_CLAIMED_DESCRIPTOR = msg({
	message: 'This gift code is invalid or already claimed.',
	comment: 'Error body shown when a gift code is invalid or already claimed.',
});
const FROM_DESCRIPTOR = msg({
	message: 'From {creatorTag}',
	comment: 'Attribution label on a gift, showing the sender FluxerTag.',
});
const THIS_GIFT_HAS_ALREADY_BEEN_CLAIMED_DESCRIPTOR = msg({
	message: 'This gift has already been claimed.',
	comment: 'Status label shown when a gift code is already redeemed.',
});
const CLAIM_YOUR_GIFT_TO_ACTIVATE_YOUR_PREMIUM_SUBSCRIPTION_DESCRIPTOR = msg({
	message: 'Claim your gift to activate your {premiumProductName} subscription!',
	comment: 'Friendly CTA shown on a valid, unclaimed gift code. Preserve {premiumProductName}; it is inserted by code.',
});
const MAYBE_LATER_DESCRIPTOR = msg({
	message: 'Maybe later',
	comment: 'Button beside Redeem and equip on a decoration code; closes the dialog without redeeming.',
});
const logger = new Logger('GiftAcceptModal');

interface GiftAcceptModalProps {
	code: string;
	target: InstanceHTTPTarget;
}

export const GiftAcceptModal = observer(function GiftAcceptModal({code, target}: GiftAcceptModalProps) {
	const {i18n} = useLingui();
	const giftState = Gifts.getGift(code, target);
	const gift = giftState?.data ?? null;
	const itemGift = giftState?.item ?? null;
	const [isRedeeming, setIsRedeeming] = useState(false);
	const [isEquipped, setIsEquipped] = useState(false);
	const giftRedeemGate = canPerform(Users.currentUser, TierGatedActions.GIFT_REDEEM);
	useEffect(() => {
		if (!giftState) {
			void GiftCommands.fetchWithCoalescing(code, target).catch((error) => {
				logger.warn('Failed to load gift for acceptance', {instanceKey: target.instanceKey, error});
			});
		}
	}, [code, giftState, target]);
	const creator = useMemo(() => {
		if (!gift?.created_by) return null;
		return new User({
			id: gift.created_by.id,
			username: gift.created_by.username,
			discriminator: gift.created_by.discriminator,
			global_name: gift.created_by.global_name,
			avatar: gift.created_by.avatar,
			avatar_color: gift.created_by.avatar_color,
			flags: gift.created_by.flags,
		});
	}, [gift?.created_by]);
	const creatorTag = creator ? NicknameUtils.getDisplayName(creator) : null;
	const handleDismiss = () => {
		ModalCommands.pop();
	};
	const handleRedeem = async () => {
		setIsRedeeming(true);
		try {
			await GiftCommands.redeem(i18n, code, target);
			if (itemGift) {
				setIsEquipped(true);
			}
		} catch (error) {
			logger.error('Failed to redeem gift:', error);
			setIsRedeeming(false);
		}
	};
	const renderLoading = () => (
		<div className={styles.loadingContent} data-flx="expressions.gift-accept-modal.render-loading.loading-content">
			<Spinner data-flx="expressions.gift-accept-modal.render-loading.spinner" />
		</div>
	);
	const renderError = () => (
		<div className={styles.card} data-flx="expressions.gift-accept-modal.render-error.card">
			<div className={styles.cardGrid} data-flx="expressions.gift-accept-modal.render-error.card-grid">
				<div
					className={`${styles.iconCircle} ${styles.iconCircleDisabled}`}
					data-flx="expressions.gift-accept-modal.render-error.icon-circle"
				>
					<QuestionIcon
						className={`${styles.icon} ${styles.iconError}`}
						data-flx="expressions.gift-accept-modal.render-error.icon"
					/>
				</div>
				<div className={styles.cardContent} data-flx="expressions.gift-accept-modal.render-error.card-content">
					<h3
						className={`${styles.title} ${styles.titleDanger}`}
						data-flx="expressions.gift-accept-modal.render-error.title"
					>
						{i18n._(UNKNOWN_GIFT_DESCRIPTOR)}
					</h3>
					<span className={styles.helpText} data-flx="expressions.gift-accept-modal.render-error.help-text">
						{i18n._(THIS_GIFT_CODE_IS_INVALID_OR_ALREADY_CLAIMED_DESCRIPTOR)}
					</span>
				</div>
			</div>
		</div>
	);
	const renderRedeemed = (title: string) => {
		return (
			<div className={styles.card} data-flx="expressions.gift-accept-modal.render-redeemed.card">
				<div className={styles.cardGrid} data-flx="expressions.gift-accept-modal.render-redeemed.card-grid">
					<div
						className={`${styles.iconCircle} ${styles.iconCircleInactive}`}
						data-flx="expressions.gift-accept-modal.render-redeemed.icon-circle"
					>
						<GiftIcon
							className={styles.icon}
							weight="fill"
							data-flx="expressions.gift-accept-modal.render-redeemed.icon"
						/>
					</div>
					<div className={styles.cardContent} data-flx="expressions.gift-accept-modal.render-redeemed.card-content">
						<h3
							className={`${styles.title} ${styles.titleTertiary}`}
							data-flx="expressions.gift-accept-modal.render-redeemed.title"
						>
							{title}
						</h3>
						{creatorTag && (
							<span className={styles.subtitle} data-flx="expressions.gift-accept-modal.render-redeemed.subtitle">
								{i18n._(FROM_DESCRIPTOR, {creatorTag})}
							</span>
						)}
						<span className={styles.helpText} data-flx="expressions.gift-accept-modal.render-redeemed.help-text">
							{i18n._(THIS_GIFT_HAS_ALREADY_BEEN_CLAIMED_DESCRIPTOR)}
						</span>
					</div>
				</div>
			</div>
		);
	};
	const renderItem = (item: CosmeticItemResponse) => {
		// Known before redeeming only when this session loaded its items; otherwise the server's answer says so.
		const isOwned = Cosmetics.getItem(item.id)?.owned ?? false;
		const typeLabel = COSMETIC_TYPE_LABELS[item.type as CosmeticType];
		return (
			<>
				<div className={styles.item} data-flx="expressions.gift-accept-modal.render-item.item">
					<div className={styles.itemStage} data-flx="expressions.gift-accept-modal.render-item.item-stage">
						<ShopItemStage
							items={[item]}
							size="grid"
							data-flx="expressions.gift-accept-modal.render-item.shop-item-stage"
						/>
					</div>
					<div className={styles.itemHeading} data-flx="expressions.gift-accept-modal.render-item.item-heading">
						<h3
							className={`${styles.title} ${styles.titlePrimary}`}
							data-flx="expressions.gift-accept-modal.render-item.title"
						>
							{item.name}
						</h3>
						{typeLabel && (
							<span className={styles.itemType} data-flx="expressions.gift-accept-modal.render-item.item-type">
								{i18n._(typeLabel)}
							</span>
						)}
					</div>
					{isOwned ? (
						<p className={styles.itemOwned} data-flx="expressions.gift-accept-modal.render-item.item-owned">
							{i18n._(ALREADY_OWNED_CODE_KEPT_DESCRIPTOR)}
						</p>
					) : (
						<p className={styles.itemText} data-flx="expressions.gift-accept-modal.render-item.item-text">
							{i18n._(CODE_GIVES_ITEM_DESCRIPTOR, {name: item.name})} {i18n._(ADDED_AND_EQUIPPED_DESCRIPTOR)}
						</p>
					)}
				</div>
				<div className={styles.footer} data-flx="expressions.gift-accept-modal.render-item.footer">
					{isOwned ? (
						<Button
							variant="secondary"
							onClick={handleDismiss}
							data-flx="expressions.gift-accept-modal.render-item.button.dismiss"
						>
							{i18n._(CLOSE_DESCRIPTOR)}
						</Button>
					) : (
						<>
							<Button
								variant="secondary"
								onClick={handleDismiss}
								disabled={isRedeeming}
								data-flx="expressions.gift-accept-modal.render-item.button.later"
							>
								{i18n._(MAYBE_LATER_DESCRIPTOR)}
							</Button>
							{giftRedeemGate.allowed ? (
								<Button
									variant="primary"
									onClick={handleRedeem}
									disabled={isRedeeming}
									submitting={isRedeeming}
									data-flx="expressions.gift-accept-modal.render-item.button.redeem"
								>
									{i18n._(REDEEM_AND_EQUIP_DESCRIPTOR)}
								</Button>
							) : (
								<Button
									variant="primary"
									onClick={() => {
										getAccountGatePresentation(i18n, giftRedeemGate).onAction();
										handleDismiss();
									}}
									data-flx="expressions.gift-accept-modal.render-item.button.gate"
								>
									{getAccountGatePresentation(i18n, giftRedeemGate).actionLabel}
								</Button>
							)}
						</>
					)}
				</div>
			</>
		);
	};
	const renderEquipped = (item: CosmeticItemResponse) => (
		<>
			<div className={styles.item} data-flx="expressions.gift-accept-modal.render-equipped.item">
				<ShopEquippedSuccess
					result={{kind: 'item', item}}
					data-flx="expressions.gift-accept-modal.render-equipped.shop-equipped-success"
				/>
			</div>
			<div className={styles.footer} data-flx="expressions.gift-accept-modal.render-equipped.footer">
				<Button
					variant="primary"
					onClick={handleDismiss}
					data-flx="expressions.gift-accept-modal.render-equipped.button.dismiss"
				>
					{i18n._(OKAY_DESCRIPTOR)}
				</Button>
			</div>
		</>
	);
	const renderGift = (gift: Gift) => {
		const durationText = getGiftDurationText(i18n, gift);
		if (!giftRedeemGate.allowed) {
			const gatePresentation = getAccountGatePresentation(i18n, giftRedeemGate);
			return (
				<>
					<div className={styles.card} data-flx="expressions.gift-accept-modal.render-gift.card">
						<div className={styles.cardGrid} data-flx="expressions.gift-accept-modal.render-gift.card-grid">
							<div
								className={`${styles.iconCircle} ${styles.iconCircleInactive}`}
								data-flx="expressions.gift-accept-modal.render-gift.icon-circle"
							>
								<GiftIcon
									className={styles.icon}
									weight="fill"
									data-flx="expressions.gift-accept-modal.render-gift.icon"
								/>
							</div>
							<div className={styles.cardContent} data-flx="expressions.gift-accept-modal.render-gift.card-content">
								<h3
									className={`${styles.title} ${styles.titlePrimary}`}
									data-flx="expressions.gift-accept-modal.render-gift.title"
								>
									{durationText}
								</h3>
								{creatorTag && (
									<span className={styles.subtitle} data-flx="expressions.gift-accept-modal.render-gift.subtitle">
										{i18n._(FROM_DESCRIPTOR, {creatorTag})}
									</span>
								)}
								<span className={styles.helpText} data-flx="expressions.gift-accept-modal.render-gift.help-text">
									{gatePresentation.description}
								</span>
							</div>
						</div>
					</div>
					<div className={styles.footer} data-flx="expressions.gift-accept-modal.render-gift.footer">
						<Button
							variant="secondary"
							onClick={handleDismiss}
							data-flx="expressions.gift-accept-modal.render-gift.button.dismiss"
						>
							<Trans>Maybe later</Trans>
						</Button>
						<Button
							variant="primary"
							onClick={() => {
								gatePresentation.onAction();
								handleDismiss();
							}}
							data-flx="expressions.gift-accept-modal.render-gift.button.open-claim-account-modal"
						>
							{gatePresentation.actionLabel}
						</Button>
					</div>
				</>
			);
		}
		return (
			<>
				<div className={styles.card} data-flx="expressions.gift-accept-modal.render-gift.card--2">
					<div className={styles.cardGrid} data-flx="expressions.gift-accept-modal.render-gift.card-grid--2">
						<div
							className={`${styles.iconCircle} ${styles.iconCircleActive}`}
							data-flx="expressions.gift-accept-modal.render-gift.icon-circle--2"
						>
							<GiftIcon
								className={styles.icon}
								weight="fill"
								data-flx="expressions.gift-accept-modal.render-gift.icon--2"
							/>
						</div>
						<div className={styles.cardContent} data-flx="expressions.gift-accept-modal.render-gift.card-content--2">
							<h3
								className={`${styles.title} ${styles.titlePrimary}`}
								data-flx="expressions.gift-accept-modal.render-gift.title--2"
							>
								{durationText}
							</h3>
							{creatorTag && (
								<span className={styles.subtitle} data-flx="expressions.gift-accept-modal.render-gift.subtitle--2">
									{i18n._(FROM_DESCRIPTOR, {creatorTag})}
								</span>
							)}
							<span className={styles.helpText} data-flx="expressions.gift-accept-modal.render-gift.help-text--2">
								{i18n._(CLAIM_YOUR_GIFT_TO_ACTIVATE_YOUR_PREMIUM_SUBSCRIPTION_DESCRIPTOR, {
									premiumProductName: getPremiumProductName(),
								})}
							</span>
						</div>
					</div>
				</div>
				<div className={styles.footer} data-flx="expressions.gift-accept-modal.render-gift.footer--2">
					<Button
						variant="secondary"
						onClick={handleDismiss}
						disabled={isRedeeming}
						data-flx="expressions.gift-accept-modal.render-gift.button.dismiss--2"
					>
						<Trans>Maybe later</Trans>
					</Button>
					<Button
						variant="primary"
						onClick={handleRedeem}
						disabled={isRedeeming}
						submitting={isRedeeming}
						data-flx="expressions.gift-accept-modal.render-gift.button.redeem"
					>
						<Trans>Claim gift</Trans>
					</Button>
				</div>
			</>
		);
	};
	const isLoading = !giftState || giftState.loading || Users.currentUser == null;
	const isUnavailable = !isLoading && !itemGift && (giftState.error || !gift || gift.redeemed);
	const header = <Modal.Header title={<Trans>Gift</Trans>} data-flx="expressions.gift-accept-modal.modal-header" />;
	const contentClassName = styles.content;
	let content: ReactNode;
	if (isLoading) {
		content = renderLoading();
	} else if (itemGift) {
		// Micup: a shop item code shows the item, then the equipped confirmation after redeeming.
		if (isEquipped) {
			content = renderEquipped(itemGift.item);
		} else if (itemGift.redeemed) {
			content = renderRedeemed(itemGift.item.name);
		} else {
			content = renderItem(itemGift.item);
		}
	} else if (giftState.error || !gift) {
		content = renderError();
	} else if (gift.redeemed) {
		content = renderRedeemed(getGiftDurationText(i18n, gift));
	} else {
		content = renderGift(gift);
	}
	return (
		<Modal.Root size="small" centered data-flx="expressions.gift-accept-modal.modal-root">
			{header}
			<Modal.Content padding="none" className={contentClassName} data-flx="expressions.gift-accept-modal.content">
				{content}
			</Modal.Content>
			{isUnavailable && <Modal.DismissFooter data-flx="expressions.gift-accept-modal.dismiss-footer" />}
		</Modal.Root>
	);
});
