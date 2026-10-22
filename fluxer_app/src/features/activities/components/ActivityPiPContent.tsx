// SPDX-License-Identifier: AGPL-3.0-or-later

import {showVoiceActivity} from '@app/features/activities/commands/VoiceActivityCommands';
import styles from '@app/features/activities/components/ActivityPiPContent.module.css';
import {ActivitySummaryCard} from '@app/features/activities/components/ActivitySummaryCard';
import ActivityViewDock from '@app/features/activities/components/ActivityViewDock';
import {ActivityViewSlot} from '@app/features/activities/components/ActivityViewSlot';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import type {ActivityPiPContent as ActivityPiPContentModel} from '@app/features/ui/state/PiP';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {PiPWindow} from '@app/features/voice/components/pip_overlay/PiPWindow';
import {msg} from '@lingui/core/macro';
import {useLingui} from '@lingui/react/macro';
import {CornersOutIcon, XIcon} from '@phosphor-icons/react';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import {useEffect, useState} from 'react';

const BACK_TO_CALL_EXPANDED_DESCRIPTOR = msg({
	message: 'Back to the call, expanded',
	comment:
		'Voice activities: button in the header of the activity mini window; returns to the voice channel with the activity filling the call area.',
});
const HIDE_MINI_WINDOW_DESCRIPTOR = msg({
	message: 'Hide the mini window',
	comment:
		'Voice activities: button in the header of the activity mini window. The activity goes on (a song keeps playing); going back to the call shows it again.',
});
const KEYS_IN_GAME_DESCRIPTOR = msg({
	message: 'Keys go to the game · click the message box to type in chat',
	comment:
		'Voice activities: line under the game in the mini window while it has the keyboard. Clicking the chat box gives the keys back to typing.',
});
const CLICK_TO_PLAY_DESCRIPTOR = msg({
	message: 'Click the game to play',
	comment:
		'Voice activities: line under the game in the mini window while the keyboard is elsewhere, for example in the chat.',
});

const OPENS_WITH_SONG_DESCRIPTOR = msg({
	message: 'The game opens here when the song starts',
	comment:
		'Voice activities: line under the summary in the mini window while the band picks a song or parts; the playable game appears in the window once the song starts. Expand to take part in the picking.',
});

const MINE_REFRESH_MS = 1_000;

// The header's "Guitar · 2:14" reads the session clock, which does not notify; a one-second tick keeps it current.
function useSecondTick(): void {
	const [, setTick] = useState(0);
	useEffect(() => {
		const timer = window.setInterval(() => setTick((tick) => tick + 1), MINE_REFRESH_MS);
		return () => window.clearInterval(timer);
	}, []);
}

// The activity I take part in, followed out of the call into the floating window: still playable, keys go to it while
// it has focus. Expanding returns to the voice channel with the activity on the call's stage.
export const ActivityPiPContent = observer(function ActivityPiPContent({
	content,
}: {
	readonly content: ActivityPiPContentModel;
}) {
	const {i18n} = useLingui();
	useSecondTick();
	const session = VoiceActivities.getSession(content.channelId);
	const live = VoiceActivities.getLive(content.channelId);
	if (!session || session.session_id !== content.sessionId) return null;
	const definition = getActivityDefinition(session.activity_id);
	const mine = live && definition.describeMine ? definition.describeMine(live, i18n) : null;
	const expand = () => showVoiceActivity(content.guildId, content.channelId);
	const expandLabel = i18n._(BACK_TO_CALL_EXPANDED_DESCRIPTOR);
	const hideLabel = i18n._(HIDE_MINI_WINDOW_DESCRIPTOR);
	const keysCaptured = ActivityViewDock.keysCaptured;
	// Song lists and part picking do not fit here: between songs the window shows the summary, and Expand takes
	// the player to the call to choose. The View waits parked and comes back when the song starts.
	const showsView = live === null || (definition.showsInTile?.(live) ?? true);
	return (
		<PiPWindow
			type="activity"
			className={styles.window}
			onActivate={expand}
			data-flx="activities.activity-pi-p-content.window"
		>
			<div className={styles.layout} data-flx="activities.activity-pi-p-content.layout">
				<header className={styles.header} data-flx="activities.activity-pi-p-content.header">
					<span className={styles.name} data-flx="activities.activity-pi-p-content.name">
						{i18n._(definition.name)}
					</span>
					{mine && (
						<span className={styles.mine} data-flx="activities.activity-pi-p-content.mine">
							{mine}
						</span>
					)}
					<Tooltip text={expandLabel} data-flx="activities.activity-pi-p-content.expand-tooltip">
						<FocusRing offset={-2} data-flx="activities.activity-pi-p-content.expand-focus-ring">
							<button
								type="button"
								className={styles.headerButton}
								onClick={expand}
								aria-label={expandLabel}
								data-flx="activities.activity-pi-p-content.expand"
							>
								<CornersOutIcon
									weight="bold"
									className={styles.headerIcon}
									data-flx="activities.activity-pi-p-content.expand-icon"
								/>
							</button>
						</FocusRing>
					</Tooltip>
					<Tooltip text={hideLabel} data-flx="activities.activity-pi-p-content.hide-tooltip">
						<FocusRing offset={-2} data-flx="activities.activity-pi-p-content.hide-focus-ring">
							<button
								type="button"
								className={styles.headerButton}
								onClick={VoiceActivities.closeMiniWindow}
								aria-label={hideLabel}
								data-flx="activities.activity-pi-p-content.hide"
							>
								<XIcon
									weight="bold"
									className={styles.headerIcon}
									data-flx="activities.activity-pi-p-content.hide-icon"
								/>
							</button>
						</FocusRing>
					</Tooltip>
				</header>
				<div className={styles.body} data-pip-no-drag="true" data-flx="activities.activity-pi-p-content.body">
					{showsView ? (
						<ActivityViewSlot placement="mini" data-flx="activities.activity-pi-p-content.view-slot" />
					) : (
						<ActivitySummaryCard
							channelId={content.channelId}
							guildId={content.guildId}
							size="tile"
							action="expand"
							onExpand={expand}
							data-flx="activities.activity-pi-p-content.summary-card"
						/>
					)}
				</div>
				<footer className={styles.footer} data-flx="activities.activity-pi-p-content.footer">
					<span
						className={clsx(styles.keysDot, showsView && keysCaptured && styles.keysDotActive)}
						aria-hidden="true"
						data-flx="activities.activity-pi-p-content.keys-dot"
					/>
					<span className={styles.keysText} aria-live="polite" data-flx="activities.activity-pi-p-content.keys-text">
						{i18n._(
							!showsView
								? OPENS_WITH_SONG_DESCRIPTOR
								: keysCaptured
									? KEYS_IN_GAME_DESCRIPTOR
									: CLICK_TO_PLAY_DESCRIPTOR,
						)}
					</span>
				</footer>
			</div>
		</PiPWindow>
	);
});
