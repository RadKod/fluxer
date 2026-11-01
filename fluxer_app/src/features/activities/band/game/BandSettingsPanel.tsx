// SPDX-License-Identifier: AGPL-3.0-or-later

import {TIMING_TITLE_DESCRIPTOR} from '@app/features/activities/band/game/BandGameLabels';
import styles from '@app/features/activities/band/game/BandSettingsPanel.module.css';
import {LatencyCalibrationScreen} from '@app/features/activities/band/game/LatencyCalibrationScreen';
import {useLingui} from '@lingui/react/macro';
import {useEffect, useRef} from 'react';

interface BandSettingsPanelProps {
	readonly onClose: () => void;
	readonly onRunningChange?: (running: boolean) => void;
}

// The timing and sound settings over the band View, from the gear on the seat screen or in a song. It stays inside
// the View, so it goes along to the mini window and never covers the rest of the app.
export function BandSettingsPanel({onClose, onRunningChange}: BandSettingsPanelProps) {
	const {i18n} = useLingui();
	const panelRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	useEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		panel.focus({preventScroll: true});
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			closeRef.current();
		};
		panel.addEventListener('keydown', onKeyDown);
		return () => {
			panel.removeEventListener('keydown', onKeyDown);
			returnTo?.focus({preventScroll: true});
		};
	}, []);

	return (
		<div className={styles.backdrop} data-flx="activities.band.game.band-settings-panel.backdrop">
			<div
				ref={panelRef}
				className={styles.panel}
				role="dialog"
				aria-modal="true"
				aria-label={i18n._(TIMING_TITLE_DESCRIPTOR)}
				tabIndex={-1}
				data-flx="activities.band.game.band-settings-panel.panel"
			>
				<LatencyCalibrationScreen
					onClose={onClose}
					onRunningChange={onRunningChange}
					data-flx="activities.band.game.band-settings-panel.latency-calibration-screen"
				/>
			</div>
		</div>
	);
}
