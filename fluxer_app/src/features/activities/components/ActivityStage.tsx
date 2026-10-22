// SPDX-License-Identifier: AGPL-3.0-or-later

import {leaveVoiceActivity} from '@app/features/activities/commands/VoiceActivityCommands';
import {
	COLLAPSE_ACTIVITY_DESCRIPTOR,
	END_ACTIVITY_DESCRIPTOR,
	LEAVE_ACTIVITY_DESCRIPTOR,
} from '@app/features/activities/components/ActivityMessages';
import styles from '@app/features/activities/components/ActivityStage.module.css';
import {ActivitySummaryCard} from '@app/features/activities/components/ActivitySummaryCard';
import {ActivityViewSlot} from '@app/features/activities/components/ActivityViewSlot';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {joinedActivitySession} from '@app/features/activities/utils/JoinedActivitySession';
import {voiceActivitiesEnabled} from '@app/features/activities/utils/VoiceActivityAvailability';
import type {Channel} from '@app/features/channel/models/Channel';
import {Button} from '@app/features/ui/button/Button';
import {LiveBadge} from '@app/features/ui/components/LiveBadge';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import MobileLayout from '@app/features/ui/state/MobileLayout';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import MediaEngine from '@app/features/voice/engine/MediaEngineFacade';
import {useLingui} from '@lingui/react/macro';
import {CornersInIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

// Observable inputs only: whether the call view has an activity to show, as a tile or on the stage.
export function isActivityShownInCall(channel: Channel): boolean {
	if (MobileLayout.isMobileLayout() || MediaEngine.channelId !== channel.id) return false;
	return voiceActivitiesEnabled(channel.guildId ?? null) && VoiceActivities.getSession(channel.id) !== null;
}

// Observable inputs only: whether the activity fills the call's stage instead of sitting in the grid. Only the user
// expands it; a starting session never does.
export function isActivityStageShown(channel: Channel): boolean {
	return isActivityShownInCall(channel) && VoiceActivities.isExpanded(channel.id);
}

// The expanded activity: the running game for someone taking part, the cover with Join for anyone else. The call's
// own fullscreen button takes it to the whole screen.
export const ActivityStage = observer(function ActivityStage({channel}: {readonly channel: Channel}) {
	const {i18n} = useLingui();
	const session = VoiceActivities.getSession(channel.id);
	if (!session) return null;
	const live = VoiceActivities.getLive(channel.id);
	const definition = getActivityDefinition(session.activity_id);
	const Icon = definition.icon;
	const joined = VoiceActivities.isJoined(channel.id);
	const showsView = joinedActivitySession()?.sessionId === session.session_id;
	const collapseLabel = i18n._(COLLAPSE_ACTIVITY_DESCRIPTOR);
	return (
		<section className={styles.stage} aria-label={i18n._(definition.name)} data-flx="activities.activity-stage.stage">
			<header className={styles.header} data-flx="activities.activity-stage.header">
				<Icon weight="fill" className={styles.icon} data-flx="activities.activity-stage.icon" />
				<h2 className={styles.title} data-flx="activities.activity-stage.title">
					{i18n._(definition.name)}
				</h2>
				<LiveBadge showTooltip={false} data-flx="activities.activity-stage.live-badge" />
				<div className={styles.spacer} data-flx="activities.activity-stage.spacer" />
				{joined && (
					<Button
						small
						variant="secondary"
						onClick={() => leaveVoiceActivity(channel.id)}
						data-flx="activities.activity-stage.leave"
					>
						{i18n._(LEAVE_ACTIVITY_DESCRIPTOR)}
					</Button>
				)}
				<Button
					small
					variant="danger"
					submitting={VoiceActivities.request === 'end'}
					disabled={!live}
					onClick={() => void live?.end()}
					data-flx="activities.activity-stage.end"
				>
					{i18n._(END_ACTIVITY_DESCRIPTOR)}
				</Button>
				<Tooltip text={collapseLabel} data-flx="activities.activity-stage.collapse-tooltip">
					<FocusRing offset={-2} data-flx="activities.activity-stage.collapse-focus-ring">
						<button
							type="button"
							className={styles.collapseButton}
							onClick={VoiceActivities.collapse}
							aria-label={collapseLabel}
							data-flx="activities.activity-stage.collapse"
						>
							<CornersInIcon
								weight="bold"
								className={styles.collapseIcon}
								data-flx="activities.activity-stage.collapse-icon"
							/>
						</button>
					</FocusRing>
				</Tooltip>
			</header>
			<div className={styles.body} data-flx="activities.activity-stage.body">
				{showsView ? (
					<ActivityViewSlot placement="stage" data-flx="activities.activity-stage.view-slot" />
				) : (
					<ActivitySummaryCard
						channelId={channel.id}
						guildId={channel.guildId ?? null}
						size="stage"
						action="join"
						data-flx="activities.activity-stage.summary-card"
					/>
				)}
			</div>
		</section>
	);
});
