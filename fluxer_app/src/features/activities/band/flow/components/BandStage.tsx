// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BandPhase} from '@app/features/activities/band/BandProtocol';
import {RETRY_DESCRIPTOR, STEP_DESCRIPTORS} from '@app/features/activities/band/flow/BandFlowMessages';
import styles from '@app/features/activities/band/flow/components/BandStage.module.css';
import {Spinner} from '@app/features/ui/components/Spinner';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import type React from 'react';

const STEPS: ReadonlyArray<BandPhase> = ['pick', 'select', 'play', 'results'];

interface BandStageProps {
	readonly phase: BandPhase | null;
	readonly children: React.ReactNode;
}

// The game's dark stage inside the activity panel, with the four steps the room goes through in order.
export function BandStage({phase, children}: BandStageProps) {
	const {i18n} = useLingui();
	const current = phase ? STEPS.indexOf(phase) : -1;
	return (
		<div className={styles.stage} data-flx="activities.band.flow.band-stage.stage">
			<ol className={styles.steps} data-flx="activities.band.flow.band-stage.steps">
				{STEPS.map((step, index) => (
					<li
						key={step}
						className={clsx(styles.step, index === current && styles.current, index < current && styles.done)}
						aria-current={index === current ? 'step' : undefined}
						data-flx="activities.band.flow.band-stage.step"
					>
						{i18n._(STEP_DESCRIPTORS[step])}
					</li>
				))}
			</ol>
			<div className={styles.body} data-flx="activities.band.flow.band-stage.body">
				{children}
			</div>
		</div>
	);
}

interface BandNoticeProps {
	readonly title?: string;
	readonly message: string;
	readonly busy?: boolean;
	readonly onRetry?: () => void;
}

// Loading and failure states in the middle of the stage.
export function BandNotice({title, message, busy = false, onRetry}: BandNoticeProps) {
	const {i18n} = useLingui();
	return (
		<div
			className={styles.notice}
			role={busy ? 'status' : 'alert'}
			data-flx="activities.band.flow.band-stage.band-notice.notice"
		>
			{busy && <Spinner data-flx="activities.band.flow.band-stage.band-notice.spinner" />}
			{title && (
				<h3 className={styles.noticeTitle} data-flx="activities.band.flow.band-stage.band-notice.notice-title">
					{title}
				</h3>
			)}
			<p className={styles.noticeText} data-flx="activities.band.flow.band-stage.band-notice.notice-text">
				{message}
			</p>
			{onRetry && (
				<button
					type="button"
					className={styles.retry}
					onClick={onRetry}
					data-flx="activities.band.flow.band-stage.band-notice.retry.button"
				>
					{i18n._(RETRY_DESCRIPTOR)}
				</button>
			)}
		</div>
	);
}
