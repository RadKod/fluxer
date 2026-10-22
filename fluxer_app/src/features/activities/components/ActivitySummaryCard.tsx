// SPDX-License-Identifier: AGPL-3.0-or-later

import {joinVoiceActivity} from '@app/features/activities/commands/VoiceActivityCommands';
import {
	EXPAND_ACTIVITY_DESCRIPTOR,
	JOIN_ACTIVITY_DESCRIPTOR,
} from '@app/features/activities/components/ActivityMessages';
import {ActivityPeople} from '@app/features/activities/components/ActivityPeople';
import styles from '@app/features/activities/components/ActivitySummaryCard.module.css';
import {getActivityDefinition} from '@app/features/activities/registry/ActivityRegistry';
import VoiceActivities from '@app/features/activities/state/VoiceActivities';
import {Button} from '@app/features/ui/button/Button';
import {LiveBadge} from '@app/features/ui/components/LiveBadge';
import {useLingui} from '@lingui/react/macro';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

// What the button on the card does: Join for someone who has not joined, Expand for a player whose tile shows this
// summary between songs, nothing where the game cannot run (the call's pop-out window).
export type ActivitySummaryAction = 'join' | 'expand' | null;

// The activity at a glance: its cover, what the room is doing, who plays, and one button.
export const ActivitySummaryCard = observer(function ActivitySummaryCard({
	channelId,
	guildId,
	size,
	action,
	onExpand = VoiceActivities.expand,
}: {
	readonly channelId: string;
	readonly guildId: string | null;
	readonly size: 'tile' | 'stage';
	readonly action: ActivitySummaryAction;
	// Where Expand goes; the mini window sends it back to the call first.
	readonly onExpand?: () => void;
}) {
	const {i18n} = useLingui();
	const session = VoiceActivities.getSession(channelId);
	if (!session) return null;
	const live = VoiceActivities.getLive(channelId);
	const {Cover, name, describeState} = getActivityDefinition(session.activity_id);
	const status = live && describeState ? describeState(live, i18n) : null;
	const handleAction = (event: React.MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (action === 'join') joinVoiceActivity(channelId);
		else onExpand();
	};
	return (
		<div
			className={clsx(styles.card, size === 'stage' && styles.stage)}
			data-flx="activities.activity-summary-card.card"
		>
			<div className={styles.cover} data-flx="activities.activity-summary-card.cover">
				<Cover size={size === 'stage' ? 'hero' : 'tile'} data-flx="activities.activity-summary-card.activity-cover" />
			</div>
			<div className={styles.info} data-flx="activities.activity-summary-card.info">
				<div className={styles.titleRow} data-flx="activities.activity-summary-card.title-row">
					<span className={styles.name} data-flx="activities.activity-summary-card.name">
						{i18n._(name)}
					</span>
					<LiveBadge showTooltip={false} tone="voice_tile" data-flx="activities.activity-summary-card.live-badge" />
				</div>
				{status && (
					<span className={styles.status} data-flx="activities.activity-summary-card.status">
						{status}
					</span>
				)}
				<div className={styles.footer} data-flx="activities.activity-summary-card.footer">
					<ActivityPeople
						session={live}
						guildId={guildId}
						channelId={channelId}
						avatarSize={size === 'stage' ? 28 : 24}
						className={styles.people}
						data-flx="activities.activity-summary-card.activity-people"
					/>
					{action && (
						<Button
							small={size === 'tile'}
							fitContent
							disabled={action === 'join' && !live}
							onClick={handleAction}
							data-flx="activities.activity-summary-card.action"
						>
							{i18n._(action === 'join' ? JOIN_ACTIVITY_DESCRIPTOR : EXPAND_ACTIVITY_DESCRIPTOR)}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
});
