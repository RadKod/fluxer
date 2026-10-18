// SPDX-License-Identifier: AGPL-3.0-or-later

import {SECONDS_DESCRIPTOR} from '@app/features/activities/band/flow/BandFlowMessages';
import styles from '@app/features/activities/band/flow/components/BandTimer.module.css';
import {secondsUntil} from '@app/features/activities/band/flow/components/useBandNow';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import type React from 'react';

interface BandTimerProps {
	// Null while the countdown has not started: the bar stays full and `waitingLabel` stands in for the seconds.
	readonly endsAt: number | null;
	readonly waitingLabel?: string;
	readonly durationMs: number;
	readonly now: number;
	readonly showSeconds?: boolean;
	readonly className?: string;
	readonly children?: React.ReactNode;
}

// Seconds left and a draining bar; children sit on the right (key hints, ready count).
export function BandTimer({
	endsAt,
	waitingLabel,
	durationMs,
	now,
	showSeconds = true,
	className,
	children,
}: BandTimerProps) {
	const {i18n} = useLingui();
	const remaining = endsAt === null ? 1 : Math.min(1, Math.max(0, (endsAt - now) / durationMs));
	return (
		<div className={clsx(styles.timer, className)} data-flx="activities.band.flow.band-timer.timer">
			{showSeconds && (
				<span
					className={clsx(styles.seconds, endsAt === null && styles.waiting)}
					data-flx="activities.band.flow.band-timer.seconds"
				>
					{endsAt === null ? waitingLabel : i18n._(SECONDS_DESCRIPTOR, {seconds: secondsUntil(endsAt, now)})}
				</span>
			)}
			<span className={styles.track} aria-hidden="true" data-flx="activities.band.flow.band-timer.track">
				<span
					className={clsx(styles.fill, endsAt === null && styles.fillIdle)}
					style={{transform: `scaleX(${remaining})`}}
					data-flx="activities.band.flow.band-timer.fill"
				/>
			</span>
			{children}
		</div>
	);
}
