// SPDX-License-Identifier: AGPL-3.0-or-later

import {PREMIUM_PRODUCT_FULL_NAME} from '@app/features/app/config/I18nDisplayConstants';
import styles from '@app/features/guild/components/GuildBadge.module.css';
import * as PremiumModalCommands from '@app/features/premium/commands/PremiumModalCommands';
import {shouldShowPremiumFeatures} from '@app/features/premium/utils/PremiumUtils';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import badgeStyles from '@app/features/user/components/PremiumUserBadge.module.css';
import type {User} from '@app/features/user/models/User';
import premiumBadgeUrl from '@app/media/images/micup-premium-badge.png';
import {PublicUserFlags} from '@fluxer/constants/src/UserConstants';
import {clsx} from 'clsx';
import type React from 'react';

interface PremiumUserBadgeProps {
	readonly user: User;
	readonly size?: number;
	readonly className?: string;
	// false inside another control (the member row button) or an aria-hidden row (the message header): mouse only.
	readonly focusable?: boolean;
	// false in the settings profile previews: a click there would switch the settings tab past the unsaved-changes check.
	readonly interactive?: boolean;
	readonly 'data-flx'?: string;
}

// Micup: the premium crown next to the name, the twin of VerifiedUserBadge. The server sets PREMIUM_BADGE on every read
// (premium and not hidden), so the flag alone decides; the image ships with the app, no CDN upload.
// a click opens the premium page. The name next to it opens the profile popout, so the click stops here.
export function PremiumUserBadge({
	user,
	size = 16,
	className,
	focusable = true,
	interactive = true,
	'data-flx': dataFlx,
}: PremiumUserBadgeProps) {
	if ((user.flags & PublicUserFlags.PREMIUM_BADGE) === 0) {
		return null;
	}
	const image = (
		<img
			src={premiumBadgeUrl}
			width={size}
			height={size}
			alt=""
			draggable={false}
			className={styles.badge}
			data-flx="user.premium-user-badge.badge"
		/>
	);
	const clickable = interactive && shouldShowPremiumFeatures();
	const openPremium = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		PremiumModalCommands.open();
	};
	if (!clickable || !focusable) {
		return (
			<Tooltip text={PREMIUM_PRODUCT_FULL_NAME} data-flx="user.premium-user-badge.tooltip">
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: mouse only; the caller keeps it out of the tab order. */}
				<span
					className={clsx(styles.badgeWrapper, clickable && badgeStyles.button, className)}
					role="img"
					aria-label={PREMIUM_PRODUCT_FULL_NAME}
					onClick={clickable ? openPremium : undefined}
					data-flx={dataFlx ?? 'user.premium-user-badge.badge-wrapper'}
				>
					{image}
				</span>
			</Tooltip>
		);
	}
	return (
		<Tooltip text={PREMIUM_PRODUCT_FULL_NAME} data-flx="user.premium-user-badge.tooltip">
			<FocusRing offset={-2} data-flx="user.premium-user-badge.focus-ring">
				<button
					type="button"
					className={clsx(styles.badgeWrapper, badgeStyles.button, className)}
					aria-label={PREMIUM_PRODUCT_FULL_NAME}
					onClick={openPremium}
					data-flx={dataFlx ?? 'user.premium-user-badge.badge-wrapper'}
				>
					{image}
				</button>
			</FocusRing>
		</Tooltip>
	);
}
