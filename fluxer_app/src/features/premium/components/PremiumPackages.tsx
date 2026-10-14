// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import styles from '@app/features/premium/components/PremiumPackages.module.css';
import {PremiumPlanCard} from '@app/features/premium/components/PremiumPlanCard';
import {ShopRedeemJumpButton} from '@app/features/shop/components/ShopRedeemField';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {
	CHOOSE_A_PLAN_DESCRIPTOR,
	ONE_TIME_PAYMENT_DESCRIPTOR,
	PREMIUM_SALES_PAUSED_DESCRIPTOR,
	REDEEM_KEY_BELOW_DESCRIPTOR,
	TIME_ADDED_ON_TOP_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import Users from '@app/features/user/state/Users';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {InfoIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';
import type React from 'react';

const PLANS_LEAD_DESCRIPTOR = msg({
	message: 'When your time is up, {premiumProductName} turns off by itself. You can add time whenever you like.',
	comment: 'Line under the heading of the Plus packages on the Plus page.',
});

// The recommended package: a seller's pick, no sales claim. Without a 3 month
// package nothing is recommended.
const RECOMMENDED_MONTHS = 3;

interface PremiumPackagesProps {
	// The page scrolls here and watches the plan buttons inside for its floating buy capsule.
	sectionRef?: React.Ref<HTMLDivElement>;
	// The page's code field, which the paused-sales notice jumps to.
	codeInputId: string;
}

export const PremiumPackages = observer(({sectionRef, codeInputId}: PremiumPackagesProps) => {
	const {i18n} = useLingui();
	const entries = ShopCatalog.packageEntries;
	const user = Users.currentUser;
	if (user?.premiumType === UserPremiumTypes.LIFETIME) return null;
	if (!ShopCatalog.settings?.premium_sales_open) {
		return (
			<div ref={sectionRef} className={styles.notice} data-flx="premium.premium-packages.notice">
				<InfoIcon className={styles.noticeIcon} aria-hidden="true" data-flx="premium.premium-packages.notice-icon" />
				<div className={styles.noticeText} data-flx="premium.premium-packages.notice-text">
					<p data-flx="premium.premium-packages.notice-title">
						{i18n._(PREMIUM_SALES_PAUSED_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
					</p>
					<p data-flx="premium.premium-packages.notice-body">{i18n._(REDEEM_KEY_BELOW_DESCRIPTOR)}</p>
					<div className={styles.noticeAction} data-flx="premium.premium-packages.notice-action">
						<ShopRedeemJumpButton inputId={codeInputId} data-flx="premium.premium-packages.redeem-jump" />
					</div>
				</div>
			</div>
		);
	}
	if (entries.length === 0) return null;
	const isPremium = user?.isPremium() ?? false;
	return (
		<div ref={sectionRef} className={styles.packages} data-flx="premium.premium-packages.packages">
			<div className={styles.head} data-flx="premium.premium-packages.head">
				<h2 className={styles.heading} data-flx="premium.premium-packages.heading">
					{i18n._(CHOOSE_A_PLAN_DESCRIPTOR)}
				</h2>
				<p className={styles.lead} data-flx="premium.premium-packages.lead">
					{i18n._(PLANS_LEAD_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
				</p>
			</div>
			<div className={styles.grid} data-flx="premium.premium-packages.grid">
				{entries.map((entry) => (
					<PremiumPlanCard
						key={entry.sku}
						entry={entry}
						recommended={entry.months === RECOMMENDED_MONTHS}
						isPremium={isPremium}
						data-flx="premium.premium-packages.premium-plan-card"
					/>
				))}
			</div>
			<p className={styles.note} data-flx="premium.premium-packages.note">
				{isPremium
					? `${i18n._(ONE_TIME_PAYMENT_DESCRIPTOR)} ${i18n._(TIME_ADDED_ON_TOP_DESCRIPTOR)}`
					: `${i18n._(ONE_TIME_PAYMENT_DESCRIPTOR)}`}
			</p>
		</div>
	);
});
