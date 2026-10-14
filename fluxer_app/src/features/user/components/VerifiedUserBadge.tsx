// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/guild/components/GuildBadge.module.css';
import {VerifiedBadgeIcon} from '@app/features/ui/components/icons/VerifiedBadgeIcon';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import type {User} from '@app/features/user/models/User';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';

export const VERIFIED_ACCOUNT_DESCRIPTOR = msg({
	message: 'Verified account',
	comment: 'Tooltip and screen reader label of the tick shown next to the name of a verified account. Keep it concise.',
});

interface VerifiedUserBadgeProps {
	readonly user: User;
	readonly size?: number;
	readonly className?: string;
	readonly 'data-flx'?: string;
}

export function VerifiedUserBadge({user, size = 16, className, 'data-flx': dataFlx}: VerifiedUserBadgeProps) {
	const {i18n} = useLingui();
	if (!user.isVerified()) {
		return null;
	}
	const label = i18n._(VERIFIED_ACCOUNT_DESCRIPTOR);
	return (
		<Tooltip text={label} data-flx="user.verified-user-badge.tooltip">
			<span
				className={clsx(styles.badgeWrapper, className)}
				role="img"
				aria-label={label}
				data-flx={dataFlx ?? 'user.verified-user-badge.badge-wrapper'}
			>
				<VerifiedBadgeIcon
					size={size}
					className={styles.badgeOnLightSurface}
					data-flx="user.verified-user-badge.verified-badge-icon"
				/>
			</span>
		</Tooltip>
	);
}
