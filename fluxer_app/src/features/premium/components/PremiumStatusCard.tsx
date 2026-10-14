// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_NAME} from '@app/features/app/config/I18nDisplayConstants';
import {PremiumHalo} from '@app/features/premium/components/PremiumHalo';
import styles from '@app/features/premium/components/PremiumStatusCard.module.css';
import {
	ADD_TIME_DESCRIPTOR,
	PREMIUM_ACTIVE_DESCRIPTOR,
	UNTIL_DATE_DAYS_LEFT_DESCRIPTOR,
	VISIONARY_NUMBER_LIFETIME_DESCRIPTOR,
} from '@app/features/shop/utils/ShopMessageDescriptors';
import {Button} from '@app/features/ui/button/Button';
import Users from '@app/features/user/state/Users';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {getFormattedLongDate} from '@fluxer/date_utils/src/DateFormatting';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';

const LIFETIME_DESCRIPTOR = msg({
	message: 'Lifetime',
	comment: 'Plus status line on the Plus sales page for an account whose Plus never ends.',
});

const DAY_MS = 24 * 60 * 60 * 1000;

interface PremiumStatusCardProps {
	// Opens the plans; null when there is nothing to buy, which hides "Add time".
	onAddTime: (() => void) | null;
	// The hero's call-to-action size, shared with its buy button.
	buttonClassName?: string;
}

export const PremiumStatusCard = observer(({onAddTime, buttonClassName}: PremiumStatusCardProps) => {
	const {i18n} = useLingui();
	const user = Users.currentUser;
	if (!user?.isPremium()) return null;
	const lifetime = user.premiumType === UserPremiumTypes.LIFETIME;
	const until = user.premiumUntil ?? null;
	let detail: string | null = null;
	if (lifetime) {
		const number = user.premiumLifetimeSequence;
		detail = number != null ? i18n._(VISIONARY_NUMBER_LIFETIME_DESCRIPTOR, {number}) : i18n._(LIFETIME_DESCRIPTOR);
	} else if (until) {
		detail = i18n._(UNTIL_DATE_DAYS_LEFT_DESCRIPTOR, {
			date: getFormattedLongDate(until, i18n.locale),
			days: Math.max(0, Math.ceil((until.getTime() - Date.now()) / DAY_MS)),
		});
	}
	return (
		<div className={styles.status} data-flx="premium.premium-status-card.status">
			<span className={styles.dot} aria-hidden="true" data-flx="premium.premium-status-card.dot" />
			<div className={styles.text} data-flx="premium.premium-status-card.text">
				<p className={styles.title} data-flx="premium.premium-status-card.title">
					{i18n._(PREMIUM_ACTIVE_DESCRIPTOR, {premiumProductName: PREMIUM_PRODUCT_NAME})}
				</p>
				{detail && (
					<p className={styles.detail} data-flx="premium.premium-status-card.detail">
						{detail}
					</p>
				)}
			</div>
			{!lifetime && onAddTime && (
				<PremiumHalo size="large" className={styles.addTime} data-flx="premium.premium-status-card.halo">
					<Button
						fitContainer
						className={buttonClassName}
						onClick={onAddTime}
						data-flx="premium.premium-status-card.button.add-time"
					>
						{i18n._(ADD_TIME_DESCRIPTOR)}
					</Button>
				</PremiumHalo>
			)}
		</div>
	);
});
