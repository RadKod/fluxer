// SPDX-License-Identifier: AGPL-3.0-or-later

import {SECONDS_DESCRIPTOR} from '@app/features/activities/band/flow/BandFlowMessages';
import styles from '@app/features/activities/band/flow/components/BandTimer.module.css';
import {secondsUntil} from '@app/features/activities/band/flow/components/useBandNow';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import type React from 'react';

interface BandTimerProps {
	readonly endsAt: number;
	readonly durationMs: number;
	readonly now: number;
	readonly showSeconds?: boolean;
	readonly className?: string;
	readonly children?: React.ReactNode;
}

// Seconds left and a draining bar; children sit on the right (key hints, ready count).
export function BandTimer({endsAt, durationMs, now, showSeconds = true, className, children}: BandTimerProps) {
	const {i18n} = useLingui();
	const remaining = Math.min(1, Math.max(0, (endsAt - now) / durationMs));
	return (
		<div className={clsx(styles.timer, className)} data-flx="activities.band.flow.band-timer.timer">
			{showSeconds && (
				<span className={styles.seconds} data-flx="activities.band.flow.band-timer.seconds">
					{i18n._(SECONDS_DESCRIPTOR, {seconds: secondsUntil(endsAt, now)})}
				</span>
			)}
			<span className={styles.track} aria-hidden="true" data-flx="activities.band.flow.band-timer.track">
				<span
					className={styles.fill}
					style={{transform: `scaleX(${remaining})`}}
					data-flx="activities.band.flow.band-timer.fill"
				/>
			</span>
			{children}
		</div>
	);
}
