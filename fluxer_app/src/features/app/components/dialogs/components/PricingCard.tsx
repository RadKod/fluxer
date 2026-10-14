// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/app/components/dialogs/components/PricingCard.module.css';
import {WAS_PRICE_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import * as LocaleUtils from '@app/features/user/utils/LocaleUtils';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {formatNumber} from '@pkgs/number_utils/src/NumberFormatting';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';
import {useCallback} from 'react';

const REMAINING_SLOTS_DESCRIPTOR = msg({
	message: '{remainingSlotCount} remaining',
	comment: 'Badge on a pricing card showing how many purchase slots remain. remainingSlotCount is localized.',
});
export const PricingCard = observer(
	({
		title,
		price,
		originalPrice,
		period,
		badge,
		isPopular,
		highlightLabel,
		isSoldOut,
		soldOut,
		owned,
		remainingSlots,
		onSelect,
		buttonText,
		isLoading = false,
		disabled = false,
		className,
		footer,
	}: {
		title: string;
		price: string;
		// Micup (shop): a campaign's pre-sale price, struck through next to the price.
		originalPrice?: string;
		period?: string;
		badge?: string;
		isPopular?: boolean;
		// Micup (shop): replaces "Most popular" on the highlighted card.
		highlightLabel?: string;
		isSoldOut?: boolean;
		soldOut?: boolean;
		owned?: boolean;
		remainingSlots?: number;
		onSelect: () => void;
		buttonText?: string;
		isLoading?: boolean;
		disabled?: boolean;
		className?: string;
		// Micup (shop): shown under the badge, above the button (a campaign countdown).
		footer?: React.ReactNode;
	}) => {
		const {i18n} = useLingui();
		const locale = LocaleUtils.getCurrentLocale();
		const actuallySoldOut = (soldOut ?? isSoldOut ?? false) && !owned;
		const isCardDisabled = disabled || actuallySoldOut || isLoading || owned;
		const handleClick = useCallback(() => {
			if (isCardDisabled) return;
			onSelect();
		}, [isCardDisabled, onSelect]);
		const getButtonVariant = (): 'primary' | 'secondary' | 'inverted' => {
			if (actuallySoldOut) return 'secondary';
			if (isPopular) return 'inverted';
			return 'primary';
		};
		const renderButtonLabel = () => {
			if (owned) return <Trans>Owned</Trans>;
			if (actuallySoldOut) return <Trans>Sold out</Trans>;
			return buttonText || <Trans>Select</Trans>;
		};
		return (
			<div
				className={clsx(
					isPopular ? styles.cardPopular : styles.cardDefault,
					isCardDisabled && styles.disabled,
					className,
				)}
				aria-busy={isLoading}
				data-flx="app.pricing-card.card-popular"
			>
				<div className={styles.popularBadgeSpace} data-flx="app.pricing-card.popular-badge-space">
					{isPopular ? (
						<div
							className={clsx(styles.popularBadge, highlightLabel && styles.popularBadgeLabel)}
							data-flx="app.pricing-card.popular-badge"
						>
							{highlightLabel ?? <Trans>Most popular</Trans>}
						</div>
					) : remainingSlots !== undefined && remainingSlots >= 0 && !actuallySoldOut ? (
						<div className={styles.popularBadge} data-flx="app.pricing-card.popular-badge--2">
							{i18n._(REMAINING_SLOTS_DESCRIPTOR, {
								remainingSlotCount: formatNumber(remainingSlots, locale),
							})}
						</div>
					) : null}
				</div>
				{actuallySoldOut && (
					<div className={styles.soldOutBadge} data-flx="app.pricing-card.sold-out-badge">
						<Trans>Sold out</Trans>
					</div>
				)}
				<div className={styles.contentContainer} data-flx="app.pricing-card.content-container">
					<h3
						className={isPopular ? styles.cardTitlePopular : styles.cardTitleDefault}
						data-flx="app.pricing-card.card-title"
					>
						{title}
					</h3>
					<p
						className={isPopular ? styles.cardPricePopular : styles.cardPriceDefault}
						data-flx="app.pricing-card.card-price"
					>
						{price}
						{originalPrice && (
							<s
								className={isPopular ? styles.originalPricePopular : styles.originalPriceDefault}
								data-flx="app.pricing-card.original-price"
							>
								<span className={styles.srOnly} data-flx="app.pricing-card.original-price-label">
									{i18n._(WAS_PRICE_DESCRIPTOR, {price: originalPrice})}
								</span>
								<span aria-hidden="true" data-flx="app.pricing-card.original-price-value">
									{originalPrice}
								</span>
							</s>
						)}
					</p>
					{period && (
						<p
							className={isPopular ? styles.cardPeriodPopular : styles.cardPeriodDefault}
							data-flx="app.pricing-card.card-period"
						>
							{period}
						</p>
					)}
					<div className={styles.badgeSpace} data-flx="app.pricing-card.badge-space">
						{badge ? (
							<span className={clsx(styles.badge, isPopular && styles.badgeOnBrand)} data-flx="app.pricing-card.badge">
								{badge}
							</span>
						) : (
							<span
								className={styles.badgePlaceholder}
								aria-hidden="true"
								data-flx="app.pricing-card.badge-placeholder"
							>
								.
							</span>
						)}
					</div>
					{footer && (
						<div className={isPopular ? styles.footerPopular : styles.footerDefault} data-flx="app.pricing-card.footer">
							{footer}
						</div>
					)}
				</div>
				<Button
					variant={getButtonVariant()}
					onClick={handleClick}
					disabled={isCardDisabled}
					submitting={isLoading}
					className={styles.selectButton}
					aria-disabled={isCardDisabled}
					aria-label={title}
					data-flx="app.pricing-card.select-button.click"
				>
					{renderButtonLabel()}
				</Button>
			</div>
		);
	},
);
