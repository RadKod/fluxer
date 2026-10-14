// SPDX-License-Identifier: AGPL-3.0-or-later

import styles from '@app/features/shop/components/ShopCountdown.module.css';
import ShopCatalog from '@app/features/shop/state/ShopCatalog';
import {SALE_ENDS_DESCRIPTOR} from '@app/features/shop/utils/ShopMessageDescriptors';
import {formatTimeLeft} from '@app/features/shop/utils/ShopTimeLeft';
import Tick from '@app/features/ui/state/Tick';
import {getFormattedDateTime} from '@app/features/user/utils/DateFormatting';
import {useLingui} from '@lingui/react/macro';
import {ClockIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {computed} from 'mobx';
import {observer} from 'mobx-react-lite';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Tick only runs while someone watches nowSecond; this one computed watches it for every countdown on screen (and the
// shop hero's campaign notes) and re-renders them once a minute, so the grid has no per-card timers and no per-second
// renders.
export const currentMinute = computed(() => Math.floor(Tick.nowSecond / 60));

interface ShopCountdownProps {
	endsAt: string;
	size: 'card' | 'dialog';
	// Restyles the countdown for where it sits, such as the shop card's meta line.
	className?: string;
}

export const ShopCountdown = observer(function ShopCountdown({endsAt, size, className}: ShopCountdownProps) {
	const {i18n} = useLingui();
	currentMinute.get();
	const endMs = Date.parse(endsAt);
	// The buy dialog follows the last hour by the second; the grid stays on the minute.
	if (size === 'dialog' && endMs - ShopCatalog.now() < HOUR_MS) void Tick.nowSecond;
	const left = endMs - ShopCatalog.now();
	// The price line drops the campaign at zero; the server enforces the end either way.
	if (left <= 0) return null;
	return (
		<span
			className={clsx(styles.countdown, size === 'dialog' && styles.dialog, className)}
			data-flx="shop.shop-countdown.countdown"
		>
			<ClockIcon className={styles.icon} aria-hidden data-flx="shop.shop-countdown.clock-icon" />
			<time
				role="timer"
				className={clsx(styles.time, left < DAY_MS && styles.warning)}
				dateTime={endsAt}
				aria-label={i18n._(SALE_ENDS_DESCRIPTOR, {date: getFormattedDateTime(endsAt)})}
				data-flx="shop.shop-countdown.time"
			>
				{formatTimeLeft(left, i18n)}
			</time>
		</span>
	);
});
